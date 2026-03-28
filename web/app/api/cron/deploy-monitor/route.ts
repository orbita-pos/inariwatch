import { NextRequest, NextResponse } from "next/server";
import { db, deployMonitors, alerts } from "@/lib/db";
import { eq, and, lte, gte, inArray } from "drizzle-orm";
import { getSlackClient } from "@/lib/slack/client";
import { buildDeployFollowUpBlocks } from "@/lib/slack/blocks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron job: check pending deploy monitors.
 * Runs every minute. Picks up deploys where checkAt <= now, counts recent errors,
 * and posts a health update to the Slack thread.
 */
export async function GET(req: NextRequest) {
  // Simple auth: cron secret or skip in dev
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Find pending monitors where checkAt has passed
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
      // Count errors in the monitoring window (last 15 minutes)
      const windowStart = new Date(monitor.createdAt?.getTime() ?? now.getTime() - 15 * 60000);
      const recentErrors = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(and(
          eq(alerts.projectId, monitor.projectId),
          gte(alerts.createdAt, windowStart),
        ))
        .limit(100);

      const errorCount = recentErrors.length;
      const healthy = errorCount < 3; // threshold: fewer than 3 errors = healthy

      // Post follow-up to Slack thread
      const client = await getSlackClient(monitor.installationId);
      const blocks = buildDeployFollowUpBlocks(healthy, errorCount);

      await client.chat.postMessage({
        channel: monitor.channelId,
        thread_ts: monitor.threadTs,
        text: healthy ? "Deploy looks healthy." : `Deploy may be causing issues (${errorCount} errors).`,
        blocks,
      });

      // Mark as checked
      await db
        .update(deployMonitors)
        .set({ status: "checked" })
        .where(eq(deployMonitors.id, monitor.id));

      processed++;
    } catch (err) {
      console.error(`[deploy-monitor] Error processing ${monitor.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, processed });
}
