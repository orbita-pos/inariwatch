import { NextResponse } from "next/server";
import {
  db,
  escalationRules,
  alerts,
  notificationLogs,
  notificationQueue,
  notificationChannels,
  projects,
  organizationMembers,
} from "@/lib/db";
import { eq, and, lte, inArray } from "drizzle-orm";
import { severityMeetsMinimum } from "@/lib/db";
import crypto from "crypto";
import { cronLog, pingCronHealth } from "@/lib/cron-utils";

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

        const severityPriority: Record<string, number> = {
          critical: 0,
          warning: 1,
          info: 2,
        };

        // ── all_org_admins: fan-out to every admin/owner channel ──────────
        if (rule.targetType === "all_org_admins") {
          const [proj] = await db
            .select({ organizationId: projects.organizationId })
            .from(projects)
            .where(eq(projects.id, rule.projectId))
            .limit(1);

          if (!proj?.organizationId) continue; // personal project

          const adminMembers = await db
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.organizationId, proj.organizationId),
                inArray(organizationMembers.role, ["owner", "admin"])
              )
            );

          for (const member of adminMembers) {
            const memberChannels = await db
              .select()
              .from(notificationChannels)
              .where(
                and(
                  eq(notificationChannels.userId, member.userId),
                  eq(notificationChannels.isActive, true)
                )
              );

            for (const ch of memberChannels) {
              const [existingLog] = await db
                .select({ id: notificationLogs.id })
                .from(notificationLogs)
                .where(
                  and(
                    eq(notificationLogs.alertId, alert.id),
                    eq(notificationLogs.channelId, ch.id)
                  )
                )
                .limit(1);
              if (existingLog) continue;

              await db.insert(notificationQueue).values({
                alertId: alert.id,
                channelId: ch.id,
                status: "pending",
                priority: severityPriority[alert.severity] ?? 1,
              });
              escalated++;
            }
          }
          continue;
        }

        // ── Standard single-channel resolution ─────────────────────────────
        let targetChannelId = rule.channelId;

        try {
          if (
            rule.targetType === "on_call_primary" ||
            rule.targetType === "on_call_secondary"
          ) {
            const level = rule.targetType === "on_call_secondary" ? 2 : 1;
            const { getCurrentOnCallUserId, getOnCallChannel } = await import(
              "@/lib/on-call"
            );
            const onCallUserId = await getCurrentOnCallUserId(
              rule.projectId,
              level
            );
            if (onCallUserId) {
              const onCallChannelId = await getOnCallChannel(onCallUserId);
              if (onCallChannelId) {
                targetChannelId = onCallChannelId;
              }
            }
          }
        } catch {
          // Failsafe
        }

        if (!targetChannelId) continue;

        const [existingLog] = await db
          .select({ id: notificationLogs.id })
          .from(notificationLogs)
          .where(
            and(
              eq(notificationLogs.alertId, alert.id),
              eq(notificationLogs.channelId, targetChannelId)
            )
          )
          .limit(1);

        if (existingLog) continue;

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

  cronLog("escalate", { escalated });
  await pingCronHealth("escalate", true);

  return NextResponse.json({ ok: true, escalated });
}
