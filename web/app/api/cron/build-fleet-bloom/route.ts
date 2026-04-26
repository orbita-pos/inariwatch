import { NextResponse } from "next/server"
import { cronLog, pingCronHealth } from "@/lib/cron-utils"
import { buildAndPersistFleetBloom } from "@/lib/fleet-bloom/build"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300 // 5 min — large fleets can have millions of patterns

const CRON_SECRET = process.env.CRON_SECRET

/**
 * GET /api/cron/build-fleet-bloom
 *
 * Daily rebuild of the public fleet bloom from `error_patterns`. Writes
 * to Redis under `fleet:bloom:current` (binary, base64) +
 * `fleet:bloom:meta` (JSON). Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Idempotent. Triggered by the Hetzner Go scheduler with
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * Suggested schedule: `30 4 * * *` (04:30 UTC daily — quiet window).
 *
 * Response shape:
 *   { ok, stats: { scanned, inserted, fpr, byteSize, versionTag, durationMs } }
 *
 * On Redis-unavailable / DB error the route still returns 200 with
 * `ok: false` so health pings reflect "cron ran but write skipped" rather
 * than a hard failure that pages the on-call.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization")
  if (!CRON_SECRET || !auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await buildAndPersistFleetBloom()
    if ("error" in result) {
      cronLog("build-fleet-bloom", { ok: false, error: result.error, durationMs: result.durationMs })
      await pingCronHealth("build-fleet-bloom", false)
      return NextResponse.json({ ok: false, error: result.error })
    }
    cronLog("build-fleet-bloom", { ok: true, ...result })
    await pingCronHealth("build-fleet-bloom", true)
    return NextResponse.json({ ok: true, stats: result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    cronLog("build-fleet-bloom", { ok: false, error: msg })
    await pingCronHealth("build-fleet-bloom", false)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
