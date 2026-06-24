import { NextResponse } from "next/server";
import crypto from "crypto";
import { cronLog, pingCronHealth } from "@/lib/cron-utils";
import { getPlatformBudgetStatus } from "@/lib/ai/spend-guard";
import { getRedis } from "@/lib/redis";
import { sendSlack } from "@/lib/notifications/slack";

/**
 * GET /api/cron/budget-alert
 *
 * Hourly cron that alerts the founder when the platform AI daily spend
 * crosses 50% / 90% / 100% of the configured cap. Runs at most once per
 * day per threshold via a Redis sentinel (`SET NX EX 86400`).
 *
 * Triggered by the Hetzner cron scheduler (internal/cron/scheduler.go),
 * authenticated with Bearer CRON_SECRET like every other cron route.
 *
 * Set FOUNDER_SLACK_WEBHOOK_URL to a Slack incoming webhook to receive
 * the alerts. Without it, the cron is a no-op (returns ok with sent: 0).
 */

const CRON_SECRET = process.env.CRON_SECRET;
const FOUNDER_SLACK_WEBHOOK_URL = process.env.FOUNDER_SLACK_WEBHOOK_URL;
const ROUTE = "budget-alert" as const;

const THRESHOLDS = [50, 90, 100] as const;

export async function GET(req: Request) {
  const start = Date.now();

  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await getPlatformBudgetStatus();
  const { usedCents, capCents, percentUsed } = status;

  // No cap configured (shouldn't happen — defaults to $20) or no Slack webhook
  // → just log and exit. The endpoint is still useful for monitoring.
  if (capCents <= 0) {
    cronLog(ROUTE, { skipped: "no cap", duration_ms: Date.now() - start });
    await pingCronHealth(ROUTE, true);
    return NextResponse.json({ ok: true, percentUsed: 0, sent: 0 });
  }

  // Identify the highest threshold currently crossed and try to claim it.
  // Iterate from highest to lowest so we always notify the most urgent
  // status. Each threshold has its own daily sentinel, so we won't double-
  // alert if the cron runs again the same day.
  const today = new Date().toISOString().slice(0, 10);
  const redis = getRedis();
  let sent = 0;
  let crossedThreshold: number | null = null;

  for (const threshold of [...THRESHOLDS].reverse()) {
    if (percentUsed < threshold) continue;
    crossedThreshold = threshold;

    // Idempotent claim: only send if no one else has fired this threshold today.
    let shouldSend = true;
    if (redis) {
      try {
        const sentinelKey = `platform_ai_notify:${today}:${threshold}`;
        const claim = await redis.set(sentinelKey, "1", { nx: true, ex: 86_400 });
        shouldSend = claim === "OK";
      } catch (err) {
        console.error("[budget-alert] sentinel claim failed:", err);
        // Fail closed on Redis error — don't spam if we can't dedupe
        shouldSend = false;
      }
    }

    if (shouldSend && FOUNDER_SLACK_WEBHOOK_URL) {
      const usedDollars = (usedCents / 100).toFixed(2);
      const capDollars = (capCents / 100).toFixed(2);
      const emoji = threshold >= 100 ? ":rotating_light:" : threshold >= 90 ? ":warning:" : ":bar_chart:";
      const message =
        `${emoji} *Platform AI daily spend at ${percentUsed}%* — ` +
        `$${usedDollars} / $${capDollars} (${threshold}% threshold reached). ` +
        (threshold >= 100
          ? "Free-tier AI is now PAUSED until midnight UTC."
          : "Approaching daily cap — free-tier AI will pause if usage continues.");
      const result = await sendSlack({ webhook_url: FOUNDER_SLACK_WEBHOOK_URL }, message);
      if (result.ok) sent = 1;
      else console.error("[budget-alert] Slack send failed:", result.error);
    }

    break; // Only fire the highest crossed threshold per run
  }

  cronLog(ROUTE, {
    used_cents: usedCents,
    cap_cents: capCents,
    percent_used: percentUsed,
    crossed_threshold: crossedThreshold,
    sent,
    duration_ms: Date.now() - start,
  });
  await pingCronHealth(ROUTE, true);

  return NextResponse.json({
    ok: true,
    usedCents,
    capCents,
    percentUsed,
    crossedThreshold,
    sent,
  });
}
