import { NextResponse } from "next/server";
import { cleanupAIUsageLogs, cronLog } from "@/lib/cron-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * GET /api/cron/cleanup-ai-logs
 *
 * Daily retention sweep for ai_usage_logs. Deletes rows older than
 * AI_LENS_RETENTION_DAYS (default 30). Required by the published
 * privacy policy commitment at /privacy.
 *
 * Triggered by the Hetzner Go scheduler with
 * `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Recommended schedule: `0 3 * * *` (03:00 UTC — low-traffic window,
 * separate from 04:00 UTC replay-retention sweep to avoid DB contention).
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await cleanupAIUsageLogs();
    cronLog("cleanup-ai-logs", { ok: true, ...result });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog("cleanup-ai-logs", { ok: false, error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
