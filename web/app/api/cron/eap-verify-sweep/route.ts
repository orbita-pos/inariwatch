import { NextResponse } from "next/server";
import { cronLog, pingCronHealth } from "@/lib/cron-utils";
import {
  sweepUnverifiedReceipts,
  isLocalVerifyEnabled,
} from "@/lib/services/eap-verify-local";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * GET /api/cron/eap-verify-sweep
 *
 * Hourly backfill of local Ed25519 verification for EAP receipts. Runs
 * `sweepUnverifiedReceipts()` in batches of 200, skipping receipts
 * younger than 1 hour (grace window for the attestation write path to
 * persist the signature).
 *
 * Idempotent. Safe to re-run mid-sweep — each row is selected by
 * `verified IS NULL` so completed rows are naturally excluded.
 *
 * Triggered by the Hetzner Go scheduler with
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * Suggested schedule: `15 * * * *` (hourly at :15 — outside the top-of-
 * hour digest window).
 *
 * Response: 200 with { ok, stats } on success, 500 on uncaught error.
 * When the feature flag is off OR EAP_SERVER_URL is unset, the sweep
 * exits early with zero-stat counters — still returns 200 so health
 * pings reflect "cron ran" rather than "cron broken".
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = await sweepUnverifiedReceipts();
    cronLog("eap-verify-sweep", {
      ok: true,
      flag: isLocalVerifyEnabled(),
      ...stats,
    });
    await pingCronHealth("eap-verify-sweep", true);
    return NextResponse.json({ ok: true, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog("eap-verify-sweep", { ok: false, error: msg });
    await pingCronHealth("eap-verify-sweep", false);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
