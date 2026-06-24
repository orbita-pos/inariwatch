import { NextResponse } from "next/server";
import { sweepRotateGrace } from "@/lib/services/project-tokens.service";
import { cronLog } from "@/lib/cron-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * GET /api/cron/rotate-grace
 *
 * Sweeps `project_tokens` rows where `rotated_to IS NOT NULL` AND the
 * 24h grace window since `created_at` has elapsed. Sets `revoked_at = now()`
 * so the next capture call bearing the old token 401s.
 *
 * Triggered by the Hetzner Go scheduler with
 * `Authorization: Bearer ${CRON_SECRET}`. Recommended schedule: every 15
 * minutes — short enough that the worst-case grace overshoot is 24h15m,
 * cheap enough that an empty sweep is a single indexed query.
 *
 * Inari Live V1 — Session 2.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sweepRotateGrace();
    cronLog("rotate-grace", { ok: true, ...result });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog("rotate-grace", { ok: false, error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
