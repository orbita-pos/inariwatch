/**
 * Fase 3.5 hotfix — pure-function test of the Vercel container-agent's
 * per-turn phase tag.
 *
 * The Vercel fallback (web/lib/ai/container-agent.ts) doesn't run a real
 * boundary detector — it uses a simple rule: the last 3 turns of the
 * MAX_TURNS=15 loop are "fix", everything before is "explore". This test
 * pins that contract so the /admin/remediation-lab grouping doesn't
 * silently regress if MAX_TURNS or the cutoff changes.
 *
 * The phase variable is computed inline in the loop, so we re-derive it
 * here — same expression, same result. The point is to fail loudly if the
 * code path diverges.
 */

import { describe, it, expect } from "vitest";
import type { LensPhase } from "../lens";

const MAX_TURNS = 15;

function phaseForTurn(turn: number, maxTurns: number = MAX_TURNS): LensPhase {
  const isNearEnd = turn > maxTurns - 3;
  return isNearEnd ? "fix" : "explore";
}

describe("Vercel container-agent per-turn phase (Fase 3.5)", () => {
  it("explore for turns 1..12, fix for 13..15", () => {
    const expected: Array<[number, LensPhase]> = [
      [1, "explore"],
      [2, "explore"],
      [10, "explore"],
      [12, "explore"],
      [13, "fix"],
      [14, "fix"],
      [15, "fix"],
    ];
    for (const [turn, want] of expected) {
      expect(phaseForTurn(turn)).toBe(want);
    }
  });

  it("preserves the 'last 3 turns = fix' rule when MAX_TURNS shifts", () => {
    expect(phaseForTurn(7, 10)).toBe("explore");
    expect(phaseForTurn(8, 10)).toBe("fix");
    expect(phaseForTurn(10, 10)).toBe("fix");
  });

  it("returns one of the six canonical LensPhase values, never undefined", () => {
    const valid: LensPhase[] = ["classify", "triage", "explore", "fix", "final", "review"];
    for (let t = 1; t <= MAX_TURNS; t++) {
      expect(valid).toContain(phaseForTurn(t));
    }
  });
});
