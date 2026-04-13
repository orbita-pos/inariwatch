/**
 * Uptime Check Job — runs on the worker, not Vercel.
 *
 * Key difference from the old cron approach:
 *   - HTTP checks run directly from Hetzner (no Vercel cold start)
 *   - State tracked in memory (lastStatus map) — DB only written on transitions
 *   - uptimeChecks rows still inserted every cycle for response time history
 *   - Alerts + auto-heal only triggered on confirmed down (3+ consecutive failures)
 *
 * DB writes per cycle:
 *   Old cron: 2N queries (1 insert + 1 update per monitor, every cycle)
 *   New worker: N inserts (check history) + ~2 on state change (rare)
 */

import { db, uptimeMonitors, uptimeChecks, alerts, projects, notificationQueue, notificationChannels } from "../db.js";
import { eq, and, desc } from "drizzle-orm";

const FAILURES_BEFORE_DOWN = 3;
const HEAL_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

// In-memory state — survives between job runs, reset on worker restart
const monitorState = new Map<string, {
  consecutiveFailures: number;
  isDown: boolean;
  healTriggeredAt: number | null;
}>();

export async function runUptimeChecks(): Promise<{ checked: number; newAlerts: number; recovered: number }> {
  let checked = 0;
  let newAlerts = 0;
  let recovered = 0;

  const now = new Date();

  // Fetch active monitors due for check
  const allMonitors = await db
    .select()
    .from(uptimeMonitors)
    .where(eq(uptimeMonitors.isActive, true));

  const dueMonitors = allMonitors.filter((m) => {
    if (!m.lastCheckedAt) return true;
    const nextCheck = new Date(m.lastCheckedAt.getTime() + m.intervalSec * 1000);
    return now >= nextCheck;
  });

  for (const monitor of dueMonitors) {
    try {
      // Initialize in-memory state from DB on first run
      if (!monitorState.has(monitor.id)) {
        monitorState.set(monitor.id, {
          consecutiveFailures: monitor.consecutiveFailures ?? 0,
          isDown: monitor.isDown ?? false,
          healTriggeredAt: monitor.healTriggeredAt?.getTime() ?? null,
        });
      }

      const state = monitorState.get(monitor.id)!;
      const start = Date.now();
      let statusCode: number | null = null;
      let responseTimeMs: number | null = null;
      let isUp = false;
      let errorMsg: string | null = null;

      // ── HTTP check ──────────────────────────────────────────────────
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
      } catch (fetchErr: unknown) {
        responseTimeMs = Date.now() - start;
        isUp = false;
        const err = fetchErr as { name?: string; message?: string };
        errorMsg = err?.name === "AbortError"
          ? `Timeout after ${monitor.timeoutMs}ms`
          : err?.message ?? "Connection failed";
      }

      // ── Record check (always — for response time history) ───────────
      await db.insert(uptimeChecks).values({
        monitorId: monitor.id,
        statusCode,
        responseTimeMs,
        isUp,
        error: errorMsg,
      });

      // ── Update state ────────────────────────────────────────────────
      const wasDown = state.isDown;
      const failures = isUp ? 0 : state.consecutiveFailures + 1;

      state.consecutiveFailures = failures;
      state.isDown = failures >= FAILURES_BEFORE_DOWN;

      // Update DB (lightweight: only counters + timestamp)
      await db
        .update(uptimeMonitors)
        .set({
          isDown: state.isDown,
          consecutiveFailures: failures,
          lastCheckedAt: now,
        })
        .where(eq(uptimeMonitors.id, monitor.id));

      // ── State transitions ───────────────────────────────────────────

      if (failures >= FAILURES_BEFORE_DOWN && !wasDown) {
        // 🔴 Confirmed DOWN — create alert + auto-heal
        const monitorName = monitor.name ?? monitor.url;
        const [downAlert] = await db.insert(alerts).values({
          projectId: monitor.projectId,
          severity: "critical",
          title: `🔴 ${monitorName} is down`,
          body: `Uptime check failed ${failures} consecutive times for ${monitor.url}.\n\n${errorMsg ?? "No response"}`,
          sourceIntegrations: ["uptime"],
        }).returning();
        newAlerts++;

        // Auto-heal check
        const healOnCooldown = state.healTriggeredAt &&
          (now.getTime() - state.healTriggeredAt) < HEAL_COOLDOWN_MS;

        if (!healOnCooldown) {
          state.healTriggeredAt = now.getTime();
          await db
            .update(uptimeMonitors)
            .set({ healTriggeredAt: now })
            .where(eq(uptimeMonitors.id, monitor.id));

          // Trigger auto-heal via Vercel (it has the integration configs)
          try {
            const workerUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
            if (workerUrl) {
              fetch(`${workerUrl}/api/cron/uptime/heal`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
                },
                body: JSON.stringify({
                  alertId: downAlert.id,
                  projectId: monitor.projectId,
                  monitorName,
                }),
                signal: AbortSignal.timeout(10000),
              }).catch(() => {});
            }
          } catch {
            // Non-blocking
          }
        }

        // Notify project owner
        await notifyProjectOwner(monitor.projectId, downAlert.id);
      } else if (isUp && wasDown) {
        // 🟢 RECOVERED — create recovery alert
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

  console.log(`[uptime] checked=${checked} alerts=${newAlerts} recovered=${recovered}`);
  return { checked, newAlerts, recovered };
}

/** Enqueue notifications for all project owner channels. */
async function notifyProjectOwner(projectId: string, alertId: string): Promise<void> {
  try {
    const [project] = await db
      .select({ userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) return;

    const channels = await db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.userId, project.userId),
          eq(notificationChannels.isActive, true)
        )
      );

    for (const ch of channels) {
      await db.insert(notificationQueue).values({
        alertId,
        channelId: ch.id,
        status: "pending",
        priority: 0,
      });
    }
  } catch {
    // Non-blocking
  }
}
