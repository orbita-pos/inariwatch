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

      // Update monitor state
      const wasDown = monitor.isDown;
      await db
        .update(uptimeMonitors)
        .set({ isDown: !isUp, lastCheckedAt: now })
        .where(eq(uptimeMonitors.id, monitor.id));

      // State transitions: create or resolve alerts
      if (!isUp && !wasDown) {
        // 🔴 Just went DOWN → create alert
        const monitorName = monitor.name ?? monitor.url;
        await db.insert(alerts).values({
          projectId: monitor.projectId,
          severity: "critical",
          title: `🔴 ${monitorName} is down`,
          body: `Uptime check failed for ${monitor.url}.\n\n${errorMsg ?? "No response"}`,
          sourceIntegrations: ["uptime"],
        });
        newAlerts++;

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

  return NextResponse.json({ ok: true, checked, newAlerts, recovered });
}
