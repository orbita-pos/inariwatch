/**
 * Shared deploy-health-check scheduler.
 *
 * When any hosting provider's webhook reports a successful production deploy,
 * call this helper to:
 *  1. Post a Slack deploy notification to the project's channel
 *  2. Capture the new thread_ts
 *  3. Insert a row into `deployMonitors` with checkAt = now + 15min
 *
 * The `/api/cron/deploy-monitor` cron job picks up pending rows every minute,
 * counts recent errors in the window, and posts a follow-up health report to
 * the same Slack thread. Supports rollback button for auto-recovery.
 *
 * Source-agnostic: the `deploySource` parameter is stored as metadata only —
 * the cron's follow-up logic is identical for Vercel, Netlify, Cloudflare
 * Pages, Render, or any future hosting provider.
 */

import { db, deployMonitors, slackMessageThreads } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { sendDeployNotification } from "@/lib/slack/send";
import { getSlackClientForProject } from "@/lib/slack/client";

export interface DeployHealthCheckInput {
  /** Project ID the deploy belongs to. */
  projectId: string;
  /** Hosting provider that produced this deploy (for audit + cron labels). */
  deploySource: "vercel" | "netlify" | "cloudflare-pages" | "render" | "github";
  /** Provider-specific deployment identifier. */
  deployId: string;
  /** Git branch that was deployed. */
  branch: string;
}

const MONITOR_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Notify Slack about a successful deploy and schedule a 15-minute error-count
 * health check. Non-blocking from the caller's perspective — catches internal
 * errors and logs them so webhook handlers don't fail because of a Slack hiccup.
 */
export async function scheduleDeployHealthCheck(
  input: DeployHealthCheckInput,
): Promise<void> {
  try {
    // 1. Post initial Slack deploy notification. This also inserts a
    //    `slackMessageThreads` row of type="deploy" we can query for.
    await sendDeployNotification(input.projectId, input.branch, "success");

    // 2. Grab the thread we just created.
    const slack = await getSlackClientForProject(input.projectId);
    if (!slack) return; // Project has no Slack integration — nothing to monitor.

    const [thread] = await db
      .select()
      .from(slackMessageThreads)
      .where(
        and(
          eq(slackMessageThreads.type, "deploy"),
          eq(slackMessageThreads.installationId, slack.installationId),
        ),
      )
      .orderBy(sql`created_at DESC`)
      .limit(1);

    if (!thread) return;

    // 3. Schedule the 15-min health check.
    await db.insert(deployMonitors).values({
      projectId: input.projectId,
      channelId: slack.channelId,
      threadTs: thread.threadTs,
      installationId: slack.installationId,
      deploySource: input.deploySource,
      deployId: input.deployId,
      checkAt: new Date(Date.now() + MONITOR_WINDOW_MS),
    });
  } catch (err) {
    console.error(
      `[deploy-health-check] Failed for ${input.deploySource}:${input.projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
