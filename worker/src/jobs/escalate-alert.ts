/**
 * Escalate Alert Job — event-driven, replaces cron polling.
 *
 * Two modes:
 *   1. Event-driven: enqueued with delay when alert is created. Checks once.
 *   2. Sweep (fallback): periodic scan for missed escalations.
 *
 * Logic: if alert is still unread + unresolved after delaySec → escalate
 * to configured target (channel, on-call, all org admins).
 */

import {
  db, alerts, escalationRules, notificationQueue, notificationChannels,
  notificationLogs, projects, organizationMembers,
} from "../db.js";
import { eq, and, lte, inArray } from "drizzle-orm";

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

function severityMeetsMinimum(alertSeverity: string, minSeverity?: string | null): boolean {
  if (!minSeverity || minSeverity === "info") return true;
  return (SEVERITY_ORDER[alertSeverity] ?? 2) <= (SEVERITY_ORDER[minSeverity] ?? 2);
}

/** Check if a notification was already sent for this alert + channel. */
async function alreadyNotified(alertId: string, channelId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: notificationLogs.id })
    .from(notificationLogs)
    .where(and(eq(notificationLogs.alertId, alertId), eq(notificationLogs.channelId, channelId)))
    .limit(1);
  return !!existing;
}

/** Enqueue a notification if not already sent. Returns true if enqueued. */
async function enqueueIfNew(alertId: string, channelId: string, priority: number): Promise<boolean> {
  if (await alreadyNotified(alertId, channelId)) return false;
  await db.insert(notificationQueue).values({
    alertId,
    channelId,
    status: "pending",
    priority,
  });
  return true;
}

// ── Event-driven: escalate a single alert ──────────────────────────────────

/**
 * Escalate a single alert. Called as a delayed job when alert is created.
 * If the alert was read or resolved in the meantime, this is a no-op.
 */
export async function escalateAlert(alertId: string): Promise<{ escalated: number }> {
  let escalated = 0;

  // Check if alert still needs escalation
  const [alert] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.isRead, false), eq(alerts.isResolved, false)))
    .limit(1);

  if (!alert) return { escalated: 0 }; // Already handled

  // Find matching rules for this project
  const rules = await db
    .select()
    .from(escalationRules)
    .where(and(eq(escalationRules.projectId, alert.projectId), eq(escalationRules.isActive, true)));

  for (const rule of rules) {
    if (!severityMeetsMinimum(alert.severity, rule.minSeverity)) continue;
    escalated += await escalateByRule(alert, rule);
  }

  if (escalated > 0) {
    console.log(`[escalation] Alert ${alertId}: escalated to ${escalated} channel(s)`);
  }
  return { escalated };
}

// ── Sweep: fallback for missed escalations ─────────────────────────────────

/**
 * Sweep all active rules and escalate any eligible alerts.
 * Runs every 5 minutes as a safety net for missed event-driven escalations.
 */
export async function escalationSweep(): Promise<{ escalated: number; errors: number }> {
  let escalated = 0;
  let errors = 0;

  const rules = await db
    .select()
    .from(escalationRules)
    .where(eq(escalationRules.isActive, true));

  for (const rule of rules) {
    try {
      const cutoff = new Date(Date.now() - rule.delaySec * 1000);

      const eligibleAlerts = await db
        .select()
        .from(alerts)
        .where(and(
          eq(alerts.projectId, rule.projectId),
          eq(alerts.isRead, false),
          eq(alerts.isResolved, false),
          lte(alerts.createdAt, cutoff)
        ));

      for (const alert of eligibleAlerts) {
        if (!severityMeetsMinimum(alert.severity, rule.minSeverity)) continue;
        escalated += await escalateByRule(alert, rule);
      }
    } catch (err) {
      errors++;
      console.error(`[escalation-sweep] Rule ${rule.id} failed:`, err);
    }
  }

  console.log(`[escalation-sweep] escalated=${escalated} errors=${errors}`);
  return { escalated, errors };
}

// ── Shared escalation logic ────────────────────────────────────────────────

type AlertRow = typeof alerts.$inferSelect;
type RuleRow = typeof escalationRules.$inferSelect;

async function escalateByRule(alert: AlertRow, rule: RuleRow): Promise<number> {
  const priority = SEVERITY_ORDER[alert.severity] ?? 1;
  let count = 0;

  if (rule.targetType === "all_org_admins") {
    count += await escalateToOrgAdmins(alert, rule.projectId, priority);
  } else if (rule.targetType === "on_call_primary" || rule.targetType === "on_call_secondary") {
    count += await escalateToOnCall(alert, rule, priority);
  } else {
    // Direct channel
    if (rule.channelId) {
      if (await enqueueIfNew(alert.id, rule.channelId, priority)) count++;
    }
  }

  return count;
}

async function escalateToOrgAdmins(alert: AlertRow, projectId: string, priority: number): Promise<number> {
  let count = 0;

  const [proj] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!proj?.organizationId) return 0;

  const admins = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(
      eq(organizationMembers.organizationId, proj.organizationId),
      inArray(organizationMembers.role, ["owner", "admin"])
    ));

  for (const admin of admins) {
    const channels = await db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(and(eq(notificationChannels.userId, admin.userId), eq(notificationChannels.isActive, true)));

    for (const ch of channels) {
      if (await enqueueIfNew(alert.id, ch.id, priority)) count++;
    }
  }

  return count;
}

async function escalateToOnCall(alert: AlertRow, rule: RuleRow, priority: number): Promise<number> {
  // On-call resolution requires schedule/slot/override tables.
  // For now, fall back to the direct channel if set.
  // TODO (week 5): Move on-call resolution logic to worker
  if (rule.channelId) {
    return (await enqueueIfNew(alert.id, rule.channelId, priority)) ? 1 : 0;
  }
  return 0;
}
