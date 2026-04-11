import { NextResponse } from "next/server";
import { resetMonthlyQuotas, currentPeriodStart } from "@/lib/ai/quota";
import { cronLog } from "@/lib/cron-utils";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Monthly quota reset cron.
 *
 * Runs day 1 of each month. Pre-creates empty quota_usage rows for all
 * users so the dashboard shows "0/300" cleanly on day 1, before they
 * make their first call.
 *
 * Old usage rows are NOT deleted — they're kept for audit/history.
 * Queries scope to current period_start automatically.
 *
 * Recommended schedule: `0 0 1 * *` (00:00 UTC on day 1)
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expected = `Bearer ${CRON_SECRET}`;
  if (auth !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const t0 = Date.now();
  try {
    const periodStart = currentPeriodStart();
    await resetMonthlyQuotas();
    const durationMs = Date.now() - t0;

    cronLog("quota-reset", { ok: true, periodStart: periodStart.toISOString(), durationMs });

    return NextResponse.json({
      ok: true,
      periodStart: periodStart.toISOString(),
      durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog("quota-reset", { ok: false, error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
