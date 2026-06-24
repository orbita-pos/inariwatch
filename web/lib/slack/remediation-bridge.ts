import { db, alerts, remediationSessions } from "@/lib/db";
import { eq } from "drizzle-orm";
import { sendRemediationStep, sendRemediationComplete, sendThreadReply } from "./send";

/**
 * Run the full remediation pipeline with Slack thread updates.
 * Called from the interactions endpoint via waitUntil() for background execution.
 */
export async function runSlackRemediation(
  alertId: string,
  userId: string,
  responseUrl: string,
): Promise<void> {
  try {
    // Verify alert exists
    const [alert] = await db
      .select()
      .from(alerts)
      .where(eq(alerts.id, alertId))
      .limit(1);

    if (!alert) {
      await postToResponseUrl(responseUrl, "Alert not found.");
      return;
    }

    // Check for existing active session
    const existingStatuses = [
      "analyzing", "reading_code", "generating_fix", "pushing", "awaiting_ci", "proposing",
    ];
    const existing = await db
      .select({ id: remediationSessions.id, status: remediationSessions.status })
      .from(remediationSessions)
      .where(eq(remediationSessions.alertId, alertId))
      .limit(10);

    const active = existing.find((s) => existingStatuses.includes(s.status));
    if (active) {
      await postToResponseUrl(responseUrl, `Remediation already in progress (status: ${active.status}).`);
      return;
    }

    // Create session
    const [session] = await db
      .insert(remediationSessions)
      .values({
        alertId,
        projectId: alert.projectId,
        userId,
        status: "analyzing",
        attempt: 1,
        maxAttempts: 3,
        steps: [],
      })
      .returning();

    await sendThreadReply(alertId, ":gear: *Remediation started.* Follow progress in this thread.");

    // Build Slack-compatible emit function
    const slackEmit = createSlackEmit(alertId, session.id);

    // Dynamic import to avoid circular deps
    const { runRemediation } = await import("@/lib/ai/remediate");
    await runRemediation(session.id, slackEmit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendThreadReply(alertId, `:x: Remediation failed: ${msg}`);
    await postToResponseUrl(responseUrl, `Remediation failed: ${msg}`);
  }
}

/**
 * Creates an emit function that translates remediation events into Slack thread replies.
 */
function createSlackEmit(alertId: string, sessionId: string) {
  let lastStepType = "";

  return (event: string, data: unknown) => {
    const d = data as Record<string, unknown>;

    switch (event) {
      case "step":
      case "step_update": {
        const step = d.step as { type: string; message: string; status: string } | undefined;
        if (!step) break;
        // Only post new steps, not updates to the same step (reduces noise)
        if (event === "step" || step.type !== lastStepType) {
          lastStepType = step.type;
          sendRemediationStep(alertId, step).catch(() => {});
        }
        break;
      }

      case "confidence": {
        const score = d.score as number;
        const badge = score >= 80 ? ":green_circle:" : score >= 50 ? ":large_orange_circle:" : ":red_circle:";
        sendThreadReply(alertId, `${badge} Diagnosis confidence: *${score}%*`).catch(() => {});
        break;
      }

      case "diff": {
        const files = d.files as { path: string }[];
        if (files?.length) {
          const list = files.map((f) => `• \`${f.path}\``).join("\n");
          sendThreadReply(alertId, `*Files changed:*\n${list}`).catch(() => {});
        }
        break;
      }

      case "self_review": {
        const score = d.score as number;
        const concerns = d.concerns as string[];
        let msg = `:mag: Self-review score: *${score}/100*`;
        if (concerns?.length) {
          msg += "\nConcerns: " + concerns.join(", ");
        }
        sendThreadReply(alertId, msg).catch(() => {});
        break;
      }

      case "done": {
        const status = d.status as string;
        const prUrl = d.prUrl as string | undefined;
        const autoMerged = d.autoMerged as boolean;

        if (status === "completed" || status === "proposing") {
          // Load confidence from session
          db.select({
              confidenceScore: remediationSessions.confidenceScore,
              context: remediationSessions.context,
            })
            .from(remediationSessions)
            .where(eq(remediationSessions.id, sessionId))
            .limit(1)
            .then(([s]) => {
              // Extract EAP receipt from stored context
              const ctx = s?.context as Record<string, unknown> | null;
              const eapReceipt = ctx?.eapReceipt as {
                verified: boolean; chainDepth: number;
                surfaces: { httpEndpoints: string[]; dbTables: string[]; llmCalls: { provider: string; model: string }[] };
              } | undefined;

              sendRemediationComplete(
                alertId,
                prUrl ?? null,
                s?.confidenceScore ?? 0,
                !!autoMerged,
                sessionId,
                eapReceipt ?? null,
              ).catch(() => {});
            })
            .catch(() => {});
        } else if (status === "failed") {
          const error = d.error as string | undefined;
          sendThreadReply(alertId, `:x: Remediation failed${error ? `: ${error}` : "."}`).catch(() => {});
        }
        break;
      }
    }
  };
}

/** Post a message to Slack's response_url (ephemeral update) */
async function postToResponseUrl(url: string, text: string): Promise<void> {
  if (!url || !url.startsWith("https://hooks.slack.com/")) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch {
    // Non-critical
  }
}
