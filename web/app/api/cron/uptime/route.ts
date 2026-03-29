import { NextResponse } from "next/server";
import {
  db,
  uptimeMonitors,
  uptimeChecks,
  alerts,
  notificationQueue,
  notificationChannels,
  projects,
} from "@/lib/db";
import { eq, and, lte, or, isNull } from "drizzle-orm";
import crypto from "crypto";
import { cronLog, pingCronHealth } from "@/lib/cron-utils";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: Request) {
  // Verify secret
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

  let checked = 0;
  let newAlerts = 0;
  let recovered = 0;

  // Fetch active monitors that are due for a check
  const now = new Date();
  const allMonitors = await db
    .select()
    .from(uptimeMonitors)
    .where(eq(uptimeMonitors.isActive, true));

  const dueMonitors = allMonitors.filter((m) => {
    if (!m.lastCheckedAt) return true; // never checked
    const nextCheck = new Date(m.lastCheckedAt.getTime() + m.intervalSec * 1000);
    return now >= nextCheck;
  });

  for (const monitor of dueMonitors) {
    try {
      const start = Date.now();
      let statusCode: number | null = null;
      let responseTimeMs: number | null = null;
      let isUp = false;
      let errorMsg: string | null = null;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), monitor.timeoutMs);

        const res = await fetch(monitor.url, {
          method: "GET",
          signal: controller.signal,
          headers: { "User-Agent": "InariWatch Uptime/1.0" },
          redirect: "follow",
        });

        clearTimeout(timeout);
        responseTimeMs = Date.now() - start;
        statusCode = res.status;
        isUp = statusCode === monitor.expectedStatus;

        if (!isUp) {
          errorMsg = `Expected ${monitor.expectedStatus}, got ${statusCode}`;
        }
      } catch (fetchErr: any) {
        responseTimeMs = Date.now() - start;
        isUp = false;
        if (fetchErr?.name === "AbortError") {
          errorMsg = `Timeout after ${monitor.timeoutMs}ms`;
        } else {
          errorMsg = fetchErr?.message ?? "Connection failed";
        }
      }

      // Record the check
      await db.insert(uptimeChecks).values({
        monitorId: monitor.id,
        statusCode,
        responseTimeMs,
        isUp,
        error: errorMsg,
      });

      // Track consecutive failures
      const wasDown = monitor.isDown;
      const failures = isUp ? 0 : (monitor.consecutiveFailures ?? 0) + 1;
      const HEAL_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown between heals
      const FAILURES_BEFORE_DOWN = 3; // require 3 consecutive failures before declaring down

      await db
        .update(uptimeMonitors)
        .set({
          isDown: failures >= FAILURES_BEFORE_DOWN,
          consecutiveFailures: failures,
          lastCheckedAt: now,
        })
        .where(eq(uptimeMonitors.id, monitor.id));

      // State transitions: only trigger on confirmed downtime (3+ consecutive failures)
      if (failures >= FAILURES_BEFORE_DOWN && !wasDown) {
        // 🔴 Confirmed DOWN (3 consecutive failures) → create alert
        const monitorName = monitor.name ?? monitor.url;
        const [downAlert] = await db.insert(alerts).values({
          projectId: monitor.projectId,
          severity: "critical",
          title: `🔴 ${monitorName} is down`,
          body: `Uptime check failed ${failures} consecutive times for ${monitor.url}.\n\n${errorMsg ?? "No response"}`,
          sourceIntegrations: ["uptime"],
        }).returning();
        newAlerts++;

        // Auto-heal: rollback + remediate if enabled (with cooldown)
        const healOnCooldown = monitor.healTriggeredAt &&
          (now.getTime() - monitor.healTriggeredAt.getTime()) < HEAL_COOLDOWN_MS;

        if (!healOnCooldown) {
          try {
            const { projectIntegrations, DEFAULT_AUTO_MERGE_CONFIG } = await import("@/lib/db");
            const [proj] = await db
              .select({ autoMergeConfig: projects.autoMergeConfig, userId: projects.userId })
              .from(projects)
              .where(eq(projects.id, monitor.projectId))
              .limit(1);

            const config = (proj?.autoMergeConfig as typeof DEFAULT_AUTO_MERGE_CONFIG | null) ?? DEFAULT_AUTO_MERGE_CONFIG;

            if (config.autoHeal && proj) {
              // Mark heal as triggered (cooldown starts)
              await db
                .update(uptimeMonitors)
                .set({ healTriggeredAt: now })
                .where(eq(uptimeMonitors.id, monitor.id));

              // Step 1: Rollback to last good deploy (Vercel)
              const [vercelInteg] = await db
                .select()
                .from(projectIntegrations)
                .where(and(
                  eq(projectIntegrations.projectId, monitor.projectId),
                  eq(projectIntegrations.service, "vercel"),
                  eq(projectIntegrations.isActive, true),
                ))
                .limit(1);

              if (vercelInteg) {
                const { decryptConfig } = await import("@/lib/crypto");
                const vercelConfig = decryptConfig(vercelInteg.configEncrypted);
                const { triggerAutoRollback } = await import("@/lib/services/auto-rollback");
                triggerAutoRollback({
                  alertId: downAlert.id,
                  token: vercelConfig.token as string,
                  teamId: vercelConfig.teamId as string | undefined,
                  vercelProjectId: (vercelConfig.projectId as string) || monitorName,
                  projectName: monitorName,
                }).catch(() => {});
              }

              // Step 2: Start AI remediation in background
              if (config.autoRemediate) {
                const { remediationSessions } = await import("@/lib/db");
                const [session] = await db
                  .insert(remediationSessions)
                  .values({
                    alertId: downAlert.id,
                    projectId: monitor.projectId,
                    userId: proj.userId,
                    status: "analyzing",
                    attempt: 1,
                    maxAttempts: 3,
                    steps: [],
                  })
                  .returning();

                import("@/lib/ai/remediate").then(({ runRemediation }) => {
                  runRemediation(session.id, () => {}).catch(() => {});
                }).catch(() => {});
              }

              // Notify Slack
              import("@/lib/slack/send").then(({ sendThreadReply }) => {
                sendThreadReply(downAlert.id,
                  `:shield: *Auto-heal activated* (${failures} consecutive failures)\n` +
                  (vercelInteg ? `1. Rolling back to last successful deploy...\n` : `1. No Vercel integration — skipping rollback\n`) +
                  (config.autoRemediate ? `2. AI remediation starting in background...\n` : `2. Auto-remediate not enabled — create a fix manually\n`) +
                  (vercelInteg ? `Your site will be back online in ~30 seconds.` : `Connect Vercel for automatic rollback.`)
                ).catch(() => {});
              }).catch(() => {});
            }
          } catch {
            // Non-blocking
          }
        }

        // Send immediate notification to all project-owner channels
        const [project] = await db
          .select({ userId: projects.userId })
          .from(projects)
          .where(eq(projects.id, monitor.projectId))
          .limit(1);

        if (project) {
          const channels = await db
            .select({ id: notificationChannels.id })
            .from(notificationChannels)
            .where(
              and(
                eq(notificationChannels.userId, project.userId),
                eq(notificationChannels.isActive, true)
              )
            );

          // Get the alert we just created
          const [newAlert] = await db
            .select({ id: alerts.id })
            .from(alerts)
            .where(eq(alerts.projectId, monitor.projectId))
            .orderBy(alerts.createdAt)
            .limit(1);

          if (newAlert) {
            for (const ch of channels) {
              await db.insert(notificationQueue).values({
                alertId: newAlert.id,
                channelId: ch.id,
                status: "pending",
                priority: 0, // critical
              });
            }
          }
        }
      } else if (isUp && wasDown) {
        // 🟢 Just RECOVERED → auto-resolve related alerts
        const monitorName = monitor.name ?? monitor.url;
        await db.insert(alerts).values({
          projectId: monitor.projectId,
          severity: "info",
          title: `🟢 ${monitorName} is back up`,
          body: `Uptime check recovered for ${monitor.url}. Response time: ${responseTimeMs}ms.`,
          sourceIntegrations: ["uptime"],
          isResolved: true,
        });
        recovered++;
      }

      checked++;
    } catch {
      // Continue processing other monitors
    }
  }

  cronLog("uptime", { checked, new_alerts: newAlerts, recovered });
  await pingCronHealth("uptime", true);

  return NextResponse.json({ ok: true, checked, newAlerts, recovered });
}
