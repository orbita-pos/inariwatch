import { NextResponse } from "next/server";
import {
  db,
  escalationRules,
  alerts,
  notificationLogs,
  notificationQueue,
  projects,
} from "@/lib/db";
import { eq, and, lte, gt } from "drizzle-orm";
import { severityMeetsMinimum } from "@/lib/db";
import crypto from "crypto";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: Request) {
  // Verify secret — same pattern as poll/route.ts
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let escalated = 0;

  // Find all active escalation rules
  const rules = await db
    .select()
    .from(escalationRules)
    .where(eq(escalationRules.isActive, true));

  for (const rule of rules) {
    try {
      // Find unread + unresolved alerts in this project older than delaySec
      const cutoff = new Date(Date.now() - rule.delaySec * 1000);

      const eligibleAlerts = await db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.projectId, rule.projectId),
            eq(alerts.isRead, false),
            eq(alerts.isResolved, false),
            lte(alerts.createdAt, cutoff)
          )
        );

      for (const alert of eligibleAlerts) {
        // Check if the alert severity meets the rule's minimum
        if (!severityMeetsMinimum(alert.severity, rule.minSeverity)) {
          continue;
        }

        // Check if escalation notification was already sent for this alert+channel
        const [existingLog] = await db
          .select({ id: notificationLogs.id })
          .from(notificationLogs)
          .where(
            and(
              eq(notificationLogs.alertId, alert.id),
              eq(notificationLogs.channelId, rule.channelId)
            )
          )
          .limit(1);

        if (existingLog) continue;

        // Resolve the target channel:
        // If the project has an on-call schedule, use the on-call user's channel
        // Otherwise fall back to the rule's configured channel
        let targetChannelId = rule.channelId;

        try {
          const { getCurrentOnCallUserId, getOnCallChannel } = await import("@/lib/on-call");
          const onCallUserId = await getCurrentOnCallUserId(rule.projectId);
          if (onCallUserId) {
            const onCallChannelId = await getOnCallChannel(onCallUserId);
            if (onCallChannelId) {
              targetChannelId = onCallChannelId;
            }
          }
        } catch {
          // If on-call resolution fails, fall back to rule's channel
        }

        // Enqueue a notification to the target channel
        const severityPriority: Record<string, number> = {
          critical: 0,
          warning: 1,
          info: 2,
        };

        await db.insert(notificationQueue).values({
          alertId: alert.id,
          channelId: targetChannelId,
          status: "pending",
          priority: severityPriority[alert.severity] ?? 1,
        });

        escalated++;
      }
    } catch {
      // Continue processing other rules even if one fails
    }
  }

  return NextResponse.json({ ok: true, escalated });
}
