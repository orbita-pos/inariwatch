/**
 * Code Intelligence v2 — Phase 3.3 cutover compute.
 *
 * Pure functions over already-fetched rows. The CLI script + the admin
 * endpoint share this module so the dashboard and the operator-run
 * smoke check are guaranteed to agree on the recommendation.
 */

import {
  CUTOVER_DIVERGENCE_MAX_PCT,
  CUTOVER_MIN_SAMPLES,
  CUTOVER_SUCCESS_PARITY_PCT,
  CUTOVER_TURN_REDUCTION_PCT,
} from "./cutover-criteria";

export interface AbSample {
  engine: "v1" | "v2";
  turnCount: number;
  success: boolean;
}

export interface ShadowSample {
  divergent: boolean;
  v2TimedOut: boolean;
}

export interface ComputeMetricsInput {
  ab: AbSample[];
  shadow: ShadowSample[];
}

export interface CutoverMetrics {
  ab: {
    total: number;
    v1Count: number;
    v2Count: number;
    v1AvgTurns: number;
    v2AvgTurns: number;
    v1SuccessPct: number;
    v2SuccessPct: number;
    turnReductionPct: number;
    successDeltaPct: number;
  };
  shadow: {
    total: number;
    divergentCount: number;
    divergencePct: number;
    timeoutCount: number;
    timeoutPct: number;
  };
}

export type CutoverRecommendation = "GO" | "WAIT" | "ABORT";

export interface CutoverGate {
  id: "samples" | "turn_reduction" | "success_parity" | "divergence";
  passed: boolean;
  detail: string;
  triggers: CutoverRecommendation;
}

export interface CutoverDecision {
  recommendation: CutoverRecommendation;
  gates: CutoverGate[];
  reasons: string[];
}

export function computeCutoverMetrics(input: ComputeMetricsInput): CutoverMetrics {
  const ab = input.ab;
  const shadow = input.shadow;
  const v1 = ab.filter((r) => r.engine === "v1");
  const v2 = ab.filter((r) => r.engine === "v2");
  const v1AvgTurns = v1.length > 0 ? sum(v1.map((r) => r.turnCount)) / v1.length : NaN;
  const v2AvgTurns = v2.length > 0 ? sum(v2.map((r) => r.turnCount)) / v2.length : NaN;
  const v1SuccessPct = v1.length > 0 ? (v1.filter((r) => r.success).length / v1.length) * 100 : 0;
  const v2SuccessPct = v2.length > 0 ? (v2.filter((r) => r.success).length / v2.length) * 100 : 0;
  const turnReductionPct =
    Number.isFinite(v1AvgTurns) && v1AvgTurns > 0 && Number.isFinite(v2AvgTurns)
      ? ((v1AvgTurns - v2AvgTurns) / v1AvgTurns) * 100
      : 0;
  const successDeltaPct = v2SuccessPct - v1SuccessPct;
  const divergentCount = shadow.filter((r) => r.divergent).length;
  const timeoutCount = shadow.filter((r) => r.v2TimedOut).length;
  return {
    ab: {
      total: ab.length,
      v1Count: v1.length,
      v2Count: v2.length,
      v1AvgTurns: round(v1AvgTurns, 2),
      v2AvgTurns: round(v2AvgTurns, 2),
      v1SuccessPct: round(v1SuccessPct, 2),
      v2SuccessPct: round(v2SuccessPct, 2),
      turnReductionPct: round(turnReductionPct, 2),
      successDeltaPct: round(successDeltaPct, 2),
    },
    shadow: {
      total: shadow.length,
      divergentCount,
      divergencePct: shadow.length > 0 ? round((divergentCount / shadow.length) * 100, 2) : 0,
      timeoutCount,
      timeoutPct: shadow.length > 0 ? round((timeoutCount / shadow.length) * 100, 2) : 0,
    },
  };
}

export function decideCutover(metrics: CutoverMetrics): CutoverDecision {
  const gates: CutoverGate[] = [];
  const enoughSamples = metrics.ab.total >= CUTOVER_MIN_SAMPLES;
  gates.push({
    id: "samples",
    passed: enoughSamples,
    detail: enoughSamples
      ? `${metrics.ab.total} A/B samples (>= ${CUTOVER_MIN_SAMPLES})`
      : `only ${metrics.ab.total} A/B samples (need >= ${CUTOVER_MIN_SAMPLES})`,
    triggers: "WAIT",
  });
  const successOk =
    metrics.ab.v2Count === 0 || metrics.ab.successDeltaPct >= CUTOVER_SUCCESS_PARITY_PCT;
  gates.push({
    id: "success_parity",
    passed: successOk,
    detail: successOk
      ? `v2 success ${metrics.ab.v2SuccessPct}% vs v1 ${metrics.ab.v1SuccessPct}% (delta ${signed(metrics.ab.successDeltaPct)}pp >= ${CUTOVER_SUCCESS_PARITY_PCT}pp)`
      : `v2 success ${metrics.ab.v2SuccessPct}% vs v1 ${metrics.ab.v1SuccessPct}% (delta ${signed(metrics.ab.successDeltaPct)}pp < ${CUTOVER_SUCCESS_PARITY_PCT}pp)`,
    triggers: "ABORT",
  });
  const turnOk =
    metrics.ab.v1Count > 0 &&
    metrics.ab.v2Count > 0 &&
    metrics.ab.turnReductionPct >= CUTOVER_TURN_REDUCTION_PCT;
  gates.push({
    id: "turn_reduction",
    passed: turnOk,
    detail: turnOk
      ? `v2 reduces avg turns ${metrics.ab.v2AvgTurns} vs v1 ${metrics.ab.v1AvgTurns} (${metrics.ab.turnReductionPct}% >= ${CUTOVER_TURN_REDUCTION_PCT}%)`
      : `v2 turns ${metrics.ab.v2AvgTurns} vs v1 ${metrics.ab.v1AvgTurns} (reduction ${metrics.ab.turnReductionPct}% < ${CUTOVER_TURN_REDUCTION_PCT}%)`,
    triggers: "WAIT",
  });
  const divergenceOk =
    metrics.shadow.total === 0 || metrics.shadow.divergencePct <= CUTOVER_DIVERGENCE_MAX_PCT;
  gates.push({
    id: "divergence",
    passed: divergenceOk,
    detail: divergenceOk
      ? `shadow divergence ${metrics.shadow.divergencePct}% (<= ${CUTOVER_DIVERGENCE_MAX_PCT}%)`
      : `shadow divergence ${metrics.shadow.divergencePct}% (> ${CUTOVER_DIVERGENCE_MAX_PCT}%)`,
    triggers: "WAIT",
  });
  const failedAbort = gates.find((g) => !g.passed && g.triggers === "ABORT");
  if (failedAbort) {
    return { recommendation: "ABORT", gates, reasons: collectReasons(gates, "ABORT") };
  }
  const failedWait = gates.filter((g) => !g.passed && g.triggers === "WAIT");
  if (failedWait.length > 0) {
    return { recommendation: "WAIT", gates, reasons: collectReasons(gates, "WAIT") };
  }
  return {
    recommendation: "GO",
    gates,
    reasons: ["All gates pass — safe to flip CODE_INTEL_V2 default to 'on'."],
  };
}

function sum(xs: number[]): number {
  let acc = 0;
  for (const x of xs) acc += x;
  return acc;
}
function round(n: number, digits: number): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
function collectReasons(gates: CutoverGate[], rec: CutoverRecommendation): string[] {
  return gates.filter((g) => !g.passed && g.triggers === rec).map((g) => g.detail);
}
