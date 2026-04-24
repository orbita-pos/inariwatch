/**
 * Fase 12 Part A — /api/cron/slo-check
 *
 * Runs every 5 minutes from the Hetzner Go scheduler. Measures per-tier
 * SLOs over the last 15 minutes of `remediation_sessions` and UPSERTs
 * breaches into `slo_events`. Recovered (tier, metric) pairs are stamped
 * `resolved_at = NOW()` so open state always reflects the current world.
 *
 * Auth: same `Bearer CRON_SECRET` as every other cron route, timing-safe.
 */

import { NextResponse } from "next/server";
import crypto from "crypto";
import { runSLOCheck } from "@/lib/ai/slo-monitor";

const CRON_SECRET = process.env.CRON_SECRET;

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

  try {
    const report = await runSLOCheck();
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - start,
      windowMinutes: report.windowMinutes,
      measurements: report.measurements,
      breaches: report.breaches,
      okPairs: report.okPairs,
      openedOrUpdated: report.openedOrUpdated.length,
      resolved: report.resolved.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: message, durationMs: Date.now() - start },
      { status: 500 }
    );
  }
}
