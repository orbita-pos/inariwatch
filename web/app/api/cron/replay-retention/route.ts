import { NextResponse } from "next/server";
import { sweepReplayRetention, countPendingRetention } from "@/lib/jobs/replay-retention";
import { cronLog } from "@/lib/cron-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * GET /api/cron/replay-retention
 *
 * Daily replay-retention sweep. Triggered by the Hetzner Go scheduler
 * with `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Recommended schedule: `0 4 * * *` (04:00 UTC — low-traffic window).
 *
 * Bounded to MAX_BATCH (200) sessions per run. If the pending queue grows
 * past that for several days in a row, bump the schedule frequency or the
 * batch size — the cronLog output exposes both numbers.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Surface the queue depth alongside the sweep result. If `pending`
    // stays > MAX_BATCH for several days, the scheduler frequency or the
    // batch cap need bumping — this is the first signal.
    const pendingBefore = await countPendingRetention();
    const result = await sweepReplayRetention();

    cronLog("replay-retention", { ok: true, pendingBefore, ...result });

    return NextResponse.json({
      ok: true,
      pendingBefore,
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog("replay-retention", { ok: false, error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
