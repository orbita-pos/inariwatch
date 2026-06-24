import { NextResponse } from "next/server";
import {
  sweepWhatIfRetention,
  countPendingWhatIfRetention,
} from "@/lib/jobs/whatif-retention";
import { cronLog } from "@/lib/cron-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * GET /api/cron/whatif-retention
 *
 * Daily cache retention sweep for `whatif_replays`. Triggered by the
 * Hetzner Go scheduler with `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Recommended schedule: `30 4 * * *` (04:30 UTC — staggered from
 * replay-retention's 04:00 to avoid DB contention).
 *
 * Policy: deletes rows older than 30 days. 1000-row cap per run.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const pendingBefore = await countPendingWhatIfRetention();
    const result = await sweepWhatIfRetention();

    cronLog("whatif-retention", { ok: true, pendingBefore, ...result });

    return NextResponse.json({
      ok: true,
      pendingBefore,
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog("whatif-retention", { ok: false, error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
