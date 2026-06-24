/**
 * Phase 3.3 — cutover compute + decision matrix.
 * Pure-function tests pinned to the constants in cutover-criteria.ts.
 */

import { describe, expect, it } from "vitest";

import {
  CUTOVER_DIVERGENCE_MAX_PCT,
  CUTOVER_MIN_SAMPLES,
  CUTOVER_SUCCESS_PARITY_PCT,
  CUTOVER_TURN_REDUCTION_PCT,
} from "../cutover-criteria";
import {
  computeCutoverMetrics,
  decideCutover,
  type AbSample,
  type ShadowSample,
} from "../cutover-eval";

function makeAb(opts: {
  v1Count: number; v2Count: number;
  v1AvgTurns: number; v2AvgTurns: number;
  v1SuccessPct: number; v2SuccessPct: number;
}): AbSample[] {
  const out: AbSample[] = [];
  const v1S = Math.round((opts.v1SuccessPct / 100) * opts.v1Count);
  for (let i = 0; i < opts.v1Count; i++) out.push({ engine: "v1", turnCount: opts.v1AvgTurns, success: i < v1S });
  const v2S = Math.round((opts.v2SuccessPct / 100) * opts.v2Count);
  for (let i = 0; i < opts.v2Count; i++) out.push({ engine: "v2", turnCount: opts.v2AvgTurns, success: i < v2S });
  return out;
}

function makeShadow(opts: { total: number; divergent: number; timedOut?: number }): ShadowSample[] {
  const out: ShadowSample[] = [];
  for (let i = 0; i < opts.total; i++) {
    out.push({ divergent: i < opts.divergent, v2TimedOut: i < (opts.timedOut ?? 0) });
  }
  return out;
}

describe("computeCutoverMetrics", () => {
  it("empty inputs → zero metrics, no NaN leakage", () => {
    const m = computeCutoverMetrics({ ab: [], shadow: [] });
    expect(m.ab.total).toBe(0);
    expect(m.shadow.total).toBe(0);
    expect(m.shadow.divergencePct).toBe(0);
  });

  it("turn reduction positive when v2 faster", () => {
    const ab = makeAb({ v1Count: 50, v2Count: 50, v1AvgTurns: 20, v2AvgTurns: 10, v1SuccessPct: 80, v2SuccessPct: 80 });
    const m = computeCutoverMetrics({ ab, shadow: [] });
    expect(m.ab.turnReductionPct).toBe(50);
  });

  it("turn reduction negative when v2 slower", () => {
    const ab = makeAb({ v1Count: 10, v2Count: 10, v1AvgTurns: 10, v2AvgTurns: 15, v1SuccessPct: 80, v2SuccessPct: 80 });
    const m = computeCutoverMetrics({ ab, shadow: [] });
    expect(m.ab.turnReductionPct).toBe(-50);
  });

  it("success delta is v2 - v1", () => {
    const ab = makeAb({ v1Count: 100, v2Count: 100, v1AvgTurns: 5, v2AvgTurns: 5, v1SuccessPct: 90, v2SuccessPct: 92 });
    expect(computeCutoverMetrics({ ab, shadow: [] }).ab.successDeltaPct).toBe(2);
  });

  it("shadow divergence + timeout pct", () => {
    const m = computeCutoverMetrics({ ab: [], shadow: makeShadow({ total: 200, divergent: 30, timedOut: 8 }) });
    expect(m.shadow.divergencePct).toBe(15);
    expect(m.shadow.timeoutPct).toBe(4);
  });
});

describe("decideCutover — GO path", () => {
  it("all gates pass → GO", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({ v1Count: 100, v2Count: 100, v1AvgTurns: 22, v2AvgTurns: 6, v1SuccessPct: 80, v2SuccessPct: 82 }),
      shadow: makeShadow({ total: 100, divergent: 10 }),
    });
    const d = decideCutover(m);
    expect(d.recommendation).toBe("GO");
    expect(d.gates.every((g) => g.passed)).toBe(true);
  });
});

describe("decideCutover — WAIT paths", () => {
  it("insufficient samples → WAIT", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({ v1Count: 30, v2Count: 30, v1AvgTurns: 22, v2AvgTurns: 6, v1SuccessPct: 80, v2SuccessPct: 82 }),
      shadow: makeShadow({ total: 100, divergent: 10 }),
    });
    const d = decideCutover(m);
    expect(d.recommendation).toBe("WAIT");
    expect(d.reasons.some((r) => /samples/i.test(r))).toBe(true);
  });

  it("turn reduction below threshold → WAIT", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({ v1Count: 100, v2Count: 100, v1AvgTurns: 20, v2AvgTurns: 18, v1SuccessPct: 80, v2SuccessPct: 82 }),
      shadow: makeShadow({ total: 100, divergent: 10 }),
    });
    const d = decideCutover(m);
    expect(d.recommendation).toBe("WAIT");
    expect(d.reasons.some((r) => /reduction/i.test(r))).toBe(true);
  });

  it("shadow divergence above threshold → WAIT", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({ v1Count: 100, v2Count: 100, v1AvgTurns: 22, v2AvgTurns: 6, v1SuccessPct: 80, v2SuccessPct: 82 }),
      shadow: makeShadow({ total: 100, divergent: 30 }),
    });
    expect(decideCutover(m).recommendation).toBe("WAIT");
  });

  it("multiple WAIT gates fail → all reasons surface", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({ v1Count: 30, v2Count: 30, v1AvgTurns: 20, v2AvgTurns: 18, v1SuccessPct: 80, v2SuccessPct: 82 }),
      shadow: makeShadow({ total: 100, divergent: 30 }),
    });
    const d = decideCutover(m);
    expect(d.recommendation).toBe("WAIT");
    expect(d.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("decideCutover — ABORT path", () => {
  it("v2 success too far below v1 → ABORT (overrides WAIT)", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({ v1Count: 100, v2Count: 100, v1AvgTurns: 22, v2AvgTurns: 6, v1SuccessPct: 80, v2SuccessPct: 70 }),
      shadow: makeShadow({ total: 100, divergent: 10 }),
    });
    const d = decideCutover(m);
    expect(d.recommendation).toBe("ABORT");
    expect(d.reasons[0]).toMatch(/success/);
  });

  it("ABORT beats WAIT when both fail", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({ v1Count: 30, v2Count: 30, v1AvgTurns: 22, v2AvgTurns: 6, v1SuccessPct: 80, v2SuccessPct: 50 }),
      shadow: makeShadow({ total: 100, divergent: 30 }),
    });
    expect(decideCutover(m).recommendation).toBe("ABORT");
  });
});

describe("decideCutover — boundary behavior", () => {
  it("exactly CUTOVER_MIN_SAMPLES → samples gate passes", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({
        v1Count: CUTOVER_MIN_SAMPLES / 2, v2Count: CUTOVER_MIN_SAMPLES / 2,
        v1AvgTurns: 22, v2AvgTurns: 6,
        v1SuccessPct: 80, v2SuccessPct: 82,
      }),
      shadow: makeShadow({ total: 100, divergent: 10 }),
    });
    expect(decideCutover(m).gates.find((g) => g.id === "samples")?.passed).toBe(true);
  });

  it("exactly CUTOVER_TURN_REDUCTION_PCT → turn gate passes", () => {
    // 30% reduction: v1=10, v2=7.
    const m = computeCutoverMetrics({
      ab: makeAb({
        v1Count: 100, v2Count: 100,
        v1AvgTurns: 10, v2AvgTurns: 7,
        v1SuccessPct: 80, v2SuccessPct: 82,
      }),
      shadow: makeShadow({ total: 100, divergent: 10 }),
    });
    expect(decideCutover(m).gates.find((g) => g.id === "turn_reduction")?.passed).toBe(true);
  });

  it("exactly CUTOVER_SUCCESS_PARITY_PCT → parity gate passes", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({
        v1Count: 100, v2Count: 100,
        v1AvgTurns: 22, v2AvgTurns: 6,
        v1SuccessPct: 80, v2SuccessPct: 80 + CUTOVER_SUCCESS_PARITY_PCT,
      }),
      shadow: makeShadow({ total: 100, divergent: 10 }),
    });
    expect(decideCutover(m).gates.find((g) => g.id === "success_parity")?.passed).toBe(true);
  });

  it("exactly CUTOVER_DIVERGENCE_MAX_PCT → divergence gate passes", () => {
    const m = computeCutoverMetrics({
      ab: makeAb({
        v1Count: 100, v2Count: 100,
        v1AvgTurns: 22, v2AvgTurns: 6,
        v1SuccessPct: 80, v2SuccessPct: 82,
      }),
      shadow: makeShadow({ total: 100, divergent: CUTOVER_DIVERGENCE_MAX_PCT }),
    });
    expect(decideCutover(m).gates.find((g) => g.id === "divergence")?.passed).toBe(true);
  });
});
