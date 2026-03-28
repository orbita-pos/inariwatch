import { db, slackMessageThreads, slackUserLinks, projects, alerts } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getSlackClientForProject, getSlackClient } from "./client";
import {
  buildAlertBlocks,
  buildIncidentStormBlocks,
  buildDeployBlocks,
  buildRemediationStepText,
  buildRemediationCompleteBlocks,
  buildPostmortemBlocks,
} from "./blocks";
import { getCurrentOnCallUserId } from "@/lib/on-call";

// ── Alert delivery ───────────────────────────────────────────────────────────

/** Send a rich alert message to the mapped Slack channel. Non-blocking. */
export async function sendAlertToSlack(
  alert: { id: string; title: string; body: string; severity: string; aiReasoning: string | null; sourceIntegrations: string[] | null; projectId: string; createdAt: Date | null },
): Promise<void> {
  const slack = await getSlackClientForProject(alert.projectId);
  if (!slack) return; // no mapping — silently skip

  // Get project name
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, alert.projectId)).limit(1);
  const projectName = project?.name ?? "Unknown";

  const { blocks, text, color } = buildAlertBlocks(alert, projectName, alert.aiReasoning);

  const result = await slack.client.chat.postMessage({
    channel: slack.channelId,
    text,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachments: [{ color, blocks: blocks as any }],
  });

  // Store thread timestamp for follow-up replies
  if (result.ts) {
    await db.insert(slackMessageThreads).values({
      installationId: slack.installationId,
      channelId: slack.channelId,
      threadTs: result.ts,
      alertId: alert.id,
      type: "alert",
    });
  }

  // Tag on-call user if critical
  if (alert.severity === "critical" && result.ts) {
    const onCallUserId = await getCurrentOnCallUserId(alert.projectId);
    if (onCallUserId) {
      const [link] = await db
        .select()
        .from(slackUserLinks)
        .where(and(
          eq(slackUserLinks.userId, onCallUserId),
          eq(slackUserLinks.installationId, slack.installationId),
        ))
        .limit(1);

      if (link) {
        await slack.client.chat.postMessage({
          channel: slack.channelId,
          thread_ts: result.ts,
          text: `cc <@${link.slackUserId}> (on-call primary)`,
        });
      }
    }
  }
}

// ── Thread replies ───────────────────────────────────────────────────────────

/** Post a text reply to an alert's Slack thread */
export async function sendThreadReply(
  alertId: string,
  text: string,
): Promise<void> {
  const thread = await getThread(alertId);
  if (!thread) return;

  const client = await getSlackClient(thread.installationId);
  await client.chat.postMessage({
    channel: thread.channelId,
    thread_ts: thread.threadTs,
    text,
  });
}

/** Post remediation step progress to thread */
export async function sendRemediationStep(
  alertId: string,
  step: { type: string; message: string; status: string },
): Promise<void> {
  const text = buildRemediationStepText(step);
  await sendThreadReply(alertId, text);
}

/** Post remediation completion to thread */
export async function sendRemediationComplete(
  alertId: string,
  prUrl: string | null,
  confidence: number,
  autoMerged: boolean,
  sessionId: string,
): Promise<void> {
  const thread = await getThread(alertId);
  if (!thread) return;

  const client = await getSlackClient(thread.installationId);
  const blocks = buildRemediationCompleteBlocks(prUrl, confidence, autoMerged, sessionId);

  await client.chat.postMessage({
    channel: thread.channelId,
    thread_ts: thread.threadTs,
    text: autoMerged ? "Fix auto-merged!" : "Draft PR created.",
    blocks,
    metadata: {
      event_type: "remediation_complete",
      event_payload: { sessionId, alertId },
    },
  });
}

// ── Incident storm ───────────────────────────────────────────────────────────

/** Create an incident storm thread */
export async function sendIncidentThread(
  stormId: string,
  projectId: string,
  alertCount: number,
  recentTitles: string[],
): Promise<void> {
  const slack = await getSlackClientForProject(projectId);
  if (!slack) return;

  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const projectName = project?.name ?? "Unknown";

  const blocks = buildIncidentStormBlocks(alertCount, projectName, recentTitles);

  const result = await slack.client.chat.postMessage({
    channel: slack.channelId,
    text: `:rotating_light: Incident Storm — ${projectName} (${alertCount} alerts)`,
    blocks,
  });

  if (result.ts) {
    await db.insert(slackMessageThreads).values({
      installationId: slack.installationId,
      channelId: slack.channelId,
      threadTs: result.ts,
      stormId,
      type: "incident",
    });
  }
}

// ── Deploy notifications ─────────────────────────────────────────────────────

/** Post a deploy notification */
export async function sendDeployNotification(
  projectId: string,
  branch: string,
  status: "success" | "failed",
): Promise<void> {
  const slack = await getSlackClientForProject(projectId);
  if (!slack) return;

  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const projectName = project?.name ?? "Unknown";

  const blocks = buildDeployBlocks(projectName, branch, status);

  const result = await slack.client.chat.postMessage({
    channel: slack.channelId,
    text: `Deploy ${status} — ${projectName} (${branch})`,
    blocks,
  });

  if (result.ts) {
    await db.insert(slackMessageThreads).values({
      installationId: slack.installationId,
      channelId: slack.channelId,
      threadTs: result.ts,
      type: "deploy",
    });
  }
}

// ── Postmortem ───────────────────────────────────────────────────────────────

/** Post a generated postmortem to the alert thread */
export async function sendPostmortem(
  alertId: string,
  postmortem: string,
  alertTitle: string,
): Promise<void> {
  const thread = await getThread(alertId);
  if (!thread) return;

  const client = await getSlackClient(thread.installationId);
  const blocks = buildPostmortemBlocks(postmortem, alertTitle);

  await client.chat.postMessage({
    channel: thread.channelId,
    thread_ts: thread.threadTs,
    text: `Postmortem — ${alertTitle}`,
    blocks,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getThread(alertId: string) {
  const [thread] = await db
    .select()
    .from(slackMessageThreads)
    .where(eq(slackMessageThreads.alertId, alertId))
    .limit(1);
  return thread ?? null;
}
