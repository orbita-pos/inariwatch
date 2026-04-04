import { describe, it, expect } from "vitest";
import { evaluateAutoMergeGates, type SelfReviewResult } from "../auto-merge-gates";
import type { AutoMergeConfig } from "@/lib/db/schema";

// ── Helpers ─────────────────────────────────────────────────────────────────

const baseConfig: AutoMergeConfig = {
  enabled: true,
  minConfidence: 80,
  maxLinesChanged: 100,
  requireSelfReview: false,
  postMergeMonitor: true,
  autoRevert: true,
  autoRemediate: false,
  autoHeal: false,
  predictionThreshold: 80,
};

const passingBase = {
  config: baseConfig,
  confidenceScore: 90,
  selfReviewResult: null as SelfReviewResult | null,
  linesChanged: 50,
  ciPassed: true,
};

// ── Gate 0: auto_merge_enabled ──────────────────────────────────────────────

describe("Gate 0: auto_merge_enabled", () => {
  it("passes when enabled", () => {
    const r = evaluateAutoMergeGates(passingBase);
    expect(r.gates[0].name).toBe("auto_merge_enabled");
    expect(r.gates[0].passed).toBe(true);
  });

  it("fails when disabled", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: { ...baseConfig, enabled: false },
    });
    expect(r.gates[0].passed).toBe(false);
    expect(r.strategy).toBe("draft_pr");
  });
});

// ── Gate 1: ci_passed ───────────────────────────────────────────────────────

describe("Gate 1: ci_passed", () => {
  it("passes when CI passes", () => {
    const r = evaluateAutoMergeGates(passingBase);
    expect(r.gates[1].name).toBe("ci_passed");
    expect(r.gates[1].passed).toBe(true);
  });

  it("fails when CI fails", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, ciPassed: false });
    expect(r.gates[1].passed).toBe(false);
    expect(r.strategy).toBe("draft_pr");
  });
});

// ── Gate 2: confidence ──────────────────────────────────────────────────────

describe("Gate 2: confidence", () => {
  it("passes when score meets threshold", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, confidenceScore: 80 });
    expect(r.gates[2].name).toBe("confidence");
    expect(r.gates[2].passed).toBe(true);
    expect(r.gates[2].reason).toContain("80%");
  });

  it("passes when score exceeds threshold", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, confidenceScore: 95 });
    expect(r.gates[2].passed).toBe(true);
  });

  it("fails when score is below threshold", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, confidenceScore: 79 });
    expect(r.gates[2].passed).toBe(false);
    expect(r.gates[2].reason).toContain("79%");
    expect(r.gates[2].reason).toContain("80%");
  });

  it("respects custom threshold", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: { ...baseConfig, minConfidence: 60 },
      confidenceScore: 65,
    });
    expect(r.gates[2].passed).toBe(true);
  });
});

// ── Gate 3: lines_changed ───────────────────────────────────────────────────

describe("Gate 3: lines_changed", () => {
  it("passes when lines at limit", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, linesChanged: 100 });
    expect(r.gates[3].name).toBe("lines_changed");
    expect(r.gates[3].passed).toBe(true);
  });

  it("fails when lines exceed limit", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, linesChanged: 101 });
    expect(r.gates[3].passed).toBe(false);
    expect(r.gates[3].reason).toContain("101");
  });

  it("passes when zero lines changed", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, linesChanged: 0 });
    expect(r.gates[3].passed).toBe(true);
  });
});

// ── Gate 4: self_review ─────────────────────────────────────────────────────

describe("Gate 4: self_review", () => {
  const reviewConfig = { ...baseConfig, requireSelfReview: true };

  it("not evaluated when not required", () => {
    const r = evaluateAutoMergeGates(passingBase);
    const gate = r.gates.find((g) => g.name === "self_review");
    expect(gate).toBeUndefined();
  });

  it("passes with good review", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: reviewConfig,
      selfReviewResult: { score: 85, recommendation: "approve", concerns: [] },
    });
    const gate = r.gates.find((g) => g.name === "self_review")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toContain("85/100");
  });

  it("fails when recommendation is reject", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: reviewConfig,
      selfReviewResult: { score: 80, recommendation: "reject", concerns: ["bad fix"] },
    });
    const gate = r.gates.find((g) => g.name === "self_review")!;
    expect(gate.passed).toBe(false);
  });

  it("fails when score below 70", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: reviewConfig,
      selfReviewResult: { score: 69, recommendation: "approve", concerns: [] },
    });
    const gate = r.gates.find((g) => g.name === "self_review")!;
    expect(gate.passed).toBe(false);
  });

  it("passes at exactly 70 with approve", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: reviewConfig,
      selfReviewResult: { score: 70, recommendation: "approve", concerns: [] },
    });
    const gate = r.gates.find((g) => g.name === "self_review")!;
    expect(gate.passed).toBe(true);
  });

  it("passes with flag recommendation if score >= 70", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: reviewConfig,
      selfReviewResult: { score: 75, recommendation: "flag", concerns: ["minor"] },
    });
    const gate = r.gates.find((g) => g.name === "self_review")!;
    expect(gate.passed).toBe(true);
  });

  it("fails when review not completed (null)", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: reviewConfig,
      selfReviewResult: null,
    });
    const gate = r.gates.find((g) => g.name === "self_review")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toContain("not completed");
  });

  it("includes concern count in reason", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: reviewConfig,
      selfReviewResult: { score: 85, recommendation: "approve", concerns: ["a", "b"] },
    });
    const gate = r.gates.find((g) => g.name === "self_review")!;
    expect(gate.reason).toContain("2 concerns");
  });
});

// ── Gate 5: substrate_simulate ──────────────────────────────────────────────

describe("Gate 5: substrate_simulate", () => {
  it("not evaluated when null", () => {
    const r = evaluateAutoMergeGates(passingBase);
    const gate = r.gates.find((g) => g.name === "substrate_simulate");
    expect(gate).toBeUndefined();
  });

  it("passes at threshold (40)", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, simulateRiskScore: 40 });
    const gate = r.gates.find((g) => g.name === "substrate_simulate")!;
    expect(gate.passed).toBe(true);
  });

  it("fails above threshold", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, simulateRiskScore: 41 });
    const gate = r.gates.find((g) => g.name === "substrate_simulate")!;
    expect(gate.passed).toBe(false);
  });

  it("passes at zero", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, simulateRiskScore: 0 });
    const gate = r.gates.find((g) => g.name === "substrate_simulate")!;
    expect(gate.passed).toBe(true);
  });
});

// ── Gate 6: eap_chain_verified ──────────────────────────────────────────────

describe("Gate 6: eap_chain_verified", () => {
  it("not evaluated when null", () => {
    const r = evaluateAutoMergeGates(passingBase);
    const gate = r.gates.find((g) => g.name === "eap_chain_verified");
    expect(gate).toBeUndefined();
  });

  it("passes when verified", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, eapChainVerified: true });
    const gate = r.gates.find((g) => g.name === "eap_chain_verified")!;
    expect(gate.passed).toBe(true);
  });

  it("fails when not verified", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, eapChainVerified: false });
    const gate = r.gates.find((g) => g.name === "eap_chain_verified")!;
    expect(gate.passed).toBe(false);
  });
});

// ── Gate 7: prediction_safe ─────────────────────────────────────────────────

describe("Gate 7: prediction_safe", () => {
  it("not evaluated when null", () => {
    const r = evaluateAutoMergeGates(passingBase);
    const gate = r.gates.find((g) => g.name === "prediction_safe");
    expect(gate).toBeUndefined();
  });

  it("passes at threshold", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, predictionRiskScore: 40 });
    const gate = r.gates.find((g) => g.name === "prediction_safe")!;
    expect(gate.passed).toBe(true);
  });

  it("fails above threshold", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, predictionRiskScore: 41 });
    const gate = r.gates.find((g) => g.name === "prediction_safe")!;
    expect(gate.passed).toBe(false);
  });
});

// ── Gate 8: security_scan ───────────────────────────────────────────────────

describe("Gate 8: security_scan", () => {
  it("not evaluated when null", () => {
    const r = evaluateAutoMergeGates(passingBase);
    const gate = r.gates.find((g) => g.name === "security_scan");
    expect(gate).toBeUndefined();
  });

  it("passes with zero HIGH findings", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, securityScanHighCount: 0 });
    const gate = r.gates.find((g) => g.name === "security_scan")!;
    expect(gate.passed).toBe(true);
  });

  it("fails with any HIGH findings", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, securityScanHighCount: 1 });
    const gate = r.gates.find((g) => g.name === "security_scan")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toContain("1 HIGH");
  });

  it("fails with multiple HIGH findings", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, securityScanHighCount: 5 });
    const gate = r.gates.find((g) => g.name === "security_scan")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toContain("5 HIGH");
  });
});

// ── Gate 9: substrate_replay ────────────────────────────────────────────────

describe("Gate 9: substrate_replay", () => {
  it("not evaluated when null", () => {
    const r = evaluateAutoMergeGates(passingBase);
    const gate = r.gates.find((g) => g.name === "substrate_replay");
    expect(gate).toBeUndefined();
  });

  it("passes when replay passed", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, substrateReplayPassed: true });
    const gate = r.gates.find((g) => g.name === "substrate_replay")!;
    expect(gate.passed).toBe(true);
  });

  it("fails when replay failed", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, substrateReplayPassed: false });
    const gate = r.gates.find((g) => g.name === "substrate_replay")!;
    expect(gate.passed).toBe(false);
  });
});

// ── Gate 10: e2e_staging ────────────────────────────────────────────────────

describe("Gate 10: e2e_staging", () => {
  it("not evaluated when null", () => {
    const r = evaluateAutoMergeGates(passingBase);
    const gate = r.gates.find((g) => g.name === "e2e_staging");
    expect(gate).toBeUndefined();
  });

  it("passes when E2E passed", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, e2eStagingPassed: true });
    const gate = r.gates.find((g) => g.name === "e2e_staging")!;
    expect(gate.passed).toBe(true);
  });

  it("fails when E2E failed", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, e2eStagingPassed: false });
    const gate = r.gates.find((g) => g.name === "e2e_staging")!;
    expect(gate.passed).toBe(false);
  });
});

// ── Overall strategy ────────────────────────────────────────────────────────

describe("Overall strategy", () => {
  it("auto_merge when all core gates pass", () => {
    const r = evaluateAutoMergeGates(passingBase);
    expect(r.passed).toBe(true);
    expect(r.strategy).toBe("auto_merge");
  });

  it("draft_pr when any gate fails", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, ciPassed: false });
    expect(r.passed).toBe(false);
    expect(r.strategy).toBe("draft_pr");
  });

  it("auto_merge with all optional gates passing", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: { ...baseConfig, requireSelfReview: true },
      selfReviewResult: { score: 90, recommendation: "approve", concerns: [] },
      simulateRiskScore: 20,
      eapChainVerified: true,
      predictionRiskScore: 10,
      securityScanHighCount: 0,
      substrateReplayPassed: true,
      e2eStagingPassed: true,
    });
    expect(r.passed).toBe(true);
    expect(r.strategy).toBe("auto_merge");
    expect(r.gates.length).toBe(11); // all 11 gates evaluated
  });

  it("draft_pr when one optional gate fails among many", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      simulateRiskScore: 20,
      eapChainVerified: true,
      predictionRiskScore: 10,
      securityScanHighCount: 2, // FAIL
      substrateReplayPassed: true,
      e2eStagingPassed: true,
    });
    expect(r.passed).toBe(false);
    expect(r.strategy).toBe("draft_pr");
  });

  it("returns correct gate count with no optional gates", () => {
    const r = evaluateAutoMergeGates(passingBase);
    // 4 core gates: enabled, ci, confidence, lines
    expect(r.gates.length).toBe(4);
  });
});
