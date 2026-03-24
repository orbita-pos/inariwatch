/**
 * Smart escalation engine — triggers escalation with full AI context
 * when the remediation pipeline fails, aborts, or has low confidence.
 *
 * Unlike the cron-based escalation (api/cron/escalate), this is invoked
 * directly from the remediation pipeline for immediate, context-rich
 * escalation to the on-call team.
 */

import {
  db,
  escalationRules,
  notificationQueue,
  notificationChannels,
  notificationLogs,
  alerts,
  projects,
  organizationMembers,
} from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { severityMeetsMinimum } from "@/lib/db";
import { getCurrentOnCallUserId, getOnCallChannel } from "@/lib/on-call";

export type EscalationReason =
  | "low_confidence"
  | "fix_failed"
  | "max_retries_exhausted"
  | "self_review_rejected"
  | "regression_after_merge";

export type EscalationContext = {
  alertId: string;
  projectId: string;
  reason: EscalationReason;
  diagnosis?: string;
  confidence?: number;
  attempts?: number;
  maxAttempts?: number;
  ciError?: string;
  selfReviewScore?: number;
  selfReviewConcerns?: string[];
  prUrl?: string;
  branch?: string;
  filesChanged?: string[];
};

/**
 * Trigger immediate escalation with AI context.
 * Returns the number of notifications enqueued.
 */
export async function triggerEscalation(ctx: EscalationContext): Promise<number> {
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, ctx.alertId))
    .limit(1);

  if (!alert) return 0;

  // Get active escalation rules for this project
  const rules = await db
    .select()
    .from(escalationRules)
    .where(
      and(
        eq(escalationRules.projectId, ctx.projectId),
        eq(escalationRules.isActive, true)
      )
    );

  if (rules.length === 0) return 0;

  // Filter rules by severity
  const matchingRules = rules.filter((r) =>
    severityMeetsMinimum(alert.severity, r.minSeverity)
  );

  if (matchingRules.length === 0) return 0;

  // For pipeline escalation, we skip the delay — escalate immediately
  // because the AI already tried and failed
  let enqueued = 0;

  for (const rule of matchingRules) {
    try {
      const channelIds = await resolveTargetChannels(rule, ctx.projectId);

      for (const channelId of channelIds) {
        // Deduplicate — don't send if already notified for this alert + channel
        const [existing] = await db
          .select({ id: notificationLogs.id })
          .from(notificationLogs)
          .where(
            and(
              eq(notificationLogs.alertId, ctx.alertId),
              eq(notificationLogs.channelId, channelId)
            )
          )
          .limit(1);

        if (existing) continue;

        const priority = alert.severity === "critical" ? 0 : 1;

        await db.insert(notificationQueue).values({
          alertId: ctx.alertId,
          channelId,
          status: "pending",
          priority,
        });

        enqueued++;
      }
    } catch {
      // Continue with other rules
    }
  }

  // Update the alert body with escalation context so the notification
  // includes AI diagnosis info when processed by the notification queue
  if (enqueued > 0) {
    const escalationSummary = buildEscalationSummary(ctx);
    await db
      .update(alerts)
      .set({
        body: `${alert.body}\n\n--- AI Escalation Context ---\n${escalationSummary}`,
      })
      .where(eq(alerts.id, ctx.alertId));
  }

  return enqueued;
}

// ── Resolve target channels ───────────────────────────────────────────────────

async function resolveTargetChannels(
  rule: typeof escalationRules.$inferSelect,
  projectId: string
): Promise<string[]> {
  // Direct channel
  if (rule.targetType === "channel" && rule.channelId) {
    return [rule.channelId];
  }

  // On-call (primary or secondary)
  if (rule.targetType === "on_call_primary" || rule.targetType === "on_call_secondary") {
    const level = rule.targetType === "on_call_secondary" ? 2 : 1;
    const userId = await getCurrentOnCallUserId(projectId, level);
    if (!userId) return [];
    const channelId = await getOnCallChannel(userId);
    return channelId ? [channelId] : [];
  }

  // All org admins
  if (rule.targetType === "all_org_admins") {
    const [proj] = await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!proj?.organizationId) return [];

    const adminMembers = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, proj.organizationId),
          inArray(organizationMembers.role, ["owner", "admin"])
        )
      );

    const channelIds: string[] = [];
    for (const member of adminMembers) {
      const channels = await db
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(
          and(
            eq(notificationChannels.userId, member.userId),
            eq(notificationChannels.isActive, true)
          )
        );
      channelIds.push(...channels.map((c) => c.id));
    }
    return channelIds;
  }

  return [];
}

// ── Build human-readable escalation summary ──────────────────────────────────

function buildEscalationSummary(ctx: EscalationContext): string {
  const lines: string[] = [];

  const reasonLabels: Record<EscalationReason, string> = {
    low_confidence: "AI confidence too low to proceed",
    fix_failed: "AI fix attempt failed",
    max_retries_exhausted: "All fix attempts exhausted",
    self_review_rejected: "AI self-review rejected the fix",
    regression_after_merge: "Regression detected after merge",
  };

  lines.push(`Reason: ${reasonLabels[ctx.reason]}`);

  if (ctx.diagnosis) {
    lines.push(`Diagnosis: ${ctx.diagnosis.slice(0, 300)}`);
  }

  if (ctx.confidence !== undefined) {
    lines.push(`Confidence: ${ctx.confidence}%`);
  }

  if (ctx.attempts !== undefined && ctx.maxAttempts !== undefined) {
    lines.push(`Attempts: ${ctx.attempts}/${ctx.maxAttempts}`);
  }

  if (ctx.ciError) {
    lines.push(`CI error: ${ctx.ciError.slice(0, 200)}`);
  }

  if (ctx.selfReviewScore !== undefined) {
    lines.push(`Self-review score: ${ctx.selfReviewScore}/100`);
  }

  if (ctx.selfReviewConcerns?.length) {
    lines.push(`Concerns: ${ctx.selfReviewConcerns.join("; ").slice(0, 200)}`);
  }

  if (ctx.prUrl) {
    lines.push(`PR: ${ctx.prUrl}`);
  }

  if (ctx.branch) {
    lines.push(`Branch: ${ctx.branch}`);
  }

  if (ctx.filesChanged?.length) {
    lines.push(`Files: ${ctx.filesChanged.join(", ")}`);
  }

  return lines.join("\n");
}
