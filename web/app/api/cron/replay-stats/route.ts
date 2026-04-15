import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { computeAndCacheStats } from "@/lib/jobs/replay-stats";
import { cronLog } from "@/lib/cron-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CRON_SECRET = process.env.CRON_SECRET;

/** Constant-time Bearer comparison — short-circuit string equality on a
 *  cron secret leaks one byte per request via timing on shared infra. */
function authIsValid(headerValue: string | null): boolean {
  if (!CRON_SECRET || !headerValue) return false;
  const expected = `Bearer ${CRON_SECRET}`;
  if (headerValue.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(headerValue), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * GET /api/cron/replay-stats
 *
 * Refreshes the public-status Redis snapshot. Triggered by the Hetzner
 * Go scheduler every 5 minutes — that's the trade-off between freshness
 * (status pages should feel live-ish) and DB load.
 *
 * Idempotent + safe to retry: just runs the same aggregation queries
 * and overwrites the Redis key. Missed ticks fall back to a 24h Redis
 * TTL so the page stays useful even after a multi-hour cron outage.
 */
export async function GET(req: Request) {
  if (!authIsValid(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  try {
    const stats = await computeAndCacheStats();
    const durationMs = Date.now() - t0;
    cronLog("replay-stats", { ok: true, durationMs, ...stats });
    return NextResponse.json({ ok: true, durationMs, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog("replay-stats", { ok: false, error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
