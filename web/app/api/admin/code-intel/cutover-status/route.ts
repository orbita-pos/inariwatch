// Code Intelligence v2 — Phase 3.3 cutover status endpoint.
//
// Aggregates `code_intel_shadow_log` + `code_intel_remediation_ab` and
// returns the GO/WAIT/ABORT recommendation. Same compute as the CLI
// (web/scripts/code-intel-v2-cutover-eval.ts).

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import {
  CUTOVER_DIVERGENCE_MAX_PCT,
  CUTOVER_MIN_SAMPLES,
  CUTOVER_SUCCESS_PARITY_PCT,
  CUTOVER_TURN_REDUCTION_PCT,
  CUTOVER_WINDOW_HOURS,
} from "@/lib/code-intelligence-v2/cutover-criteria";
import { computeCutoverMetrics, decideCutover } from "@/lib/code-intelligence-v2/cutover-eval";
import { fetchCutoverInputs } from "@/lib/code-intelligence-v2/cutover-fetch";

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email || email !== process.env.ADMIN_EMAIL) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let inputs;
  try {
    inputs = await fetchCutoverInputs({ windowHours: CUTOVER_WINDOW_HOURS });
  } catch (err) {
    return NextResponse.json(
      { error: "fetch_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  const metrics = computeCutoverMetrics(inputs);
  const decision = decideCutover(metrics);
  return NextResponse.json({
    windowHours: CUTOVER_WINDOW_HOURS,
    thresholds: {
      minSamples: CUTOVER_MIN_SAMPLES,
      turnReductionPct: CUTOVER_TURN_REDUCTION_PCT,
      successParityPct: CUTOVER_SUCCESS_PARITY_PCT,
      divergenceMaxPct: CUTOVER_DIVERGENCE_MAX_PCT,
    },
    metrics,
    decision,
  });
}
