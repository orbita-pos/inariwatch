/**
 * Deploy Monitor Job — checks deploy health after a delay.
 *
 * Two modes:
 *   1. Event-driven: enqueued with 15min delay when deploy webhook arrives
 *   2. Sweep: periodic check for pending monitors (fallback)
 *
 * The worker handles DB queries (find pending monitors, count errors).
 * Slack posting is delegated to Vercel (it has the Slack tokens + blocks builder).
 */

import { db, deployMonitors, alerts } from "../db.js";
import { eq, and, lte, gte } from "drizzle-orm";

const APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

/**
 * Process a single deploy monitor by ID.
 * Called as a delayed job when a deploy webhook creates a monitor.
 */
export async function checkDeployHealth(monitorId: string): Promise<void> {
  const [monitor] = await db
    .select()
    .from(deployMonitors)
    .where(and(eq(deployMonitors.id, monitorId), eq(deployMonitors.status, "pending")))
    .limit(1);

  if (!monitor) return; // Already processed or doesn't exist

  await processMonitor(monitor);
}

/**
 * Sweep all pending monitors where checkAt has passed.
 * Fallback for missed event-driven jobs.
 */
export async function deployMonitorSweep(): Promise<{ processed: number }> {
  const now = new Date();

  const pending = await db
    .select()
    .from(deployMonitors)
    .where(and(
      eq(deployMonitors.status, "pending"),
      lte(deployMonitors.checkAt, now),
    ))
    .limit(20);

  let processed = 0;
  for (const monitor of pending) {
    try {
      await processMonitor(monitor);
      processed++;
    } catch (err) {
      console.error(`[deploy-monitor] Error processing ${monitor.id}:`, err);
    }
  }

  console.log(`[deploy-monitor] processed=${processed}`);
  return { processed };
}

async function processMonitor(monitor: typeof deployMonitors.$inferSelect): Promise<void> {
  const now = new Date();
  const windowStart = new Date(monitor.createdAt?.getTime() ?? (now.getTime() - 15 * 60_000));

  // Count errors in the monitoring window
  const recentErrors = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(
      eq(alerts.projectId, monitor.projectId),
      gte(alerts.createdAt, windowStart),
    ))
    .limit(100);

  const errorCount = recentErrors.length;
  const healthy = errorCount < 3;

  // Delegate Slack posting to Vercel (has Slack tokens + block builder)
  if (APP_URL) {
    try {
      await fetch(`${APP_URL}/api/cron/deploy-monitor/notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CRON_SECRET}`,
        },
        body: JSON.stringify({
          monitorId: monitor.id,
          channelId: monitor.channelId,
          threadTs: monitor.threadTs,
          installationId: monitor.installationId,
          deploySource: monitor.deploySource,
          healthy,
          errorCount,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Non-blocking — Slack failure shouldn't prevent marking as checked
    }
  }

  // Mark as checked
  await db
    .update(deployMonitors)
    .set({ status: "checked" })
    .where(eq(deployMonitors.id, monitor.id));
}
