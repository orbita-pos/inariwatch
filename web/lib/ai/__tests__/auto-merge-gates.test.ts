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

// ── Cross-gate adversarial interactions ─────────────────────────────────────

describe("Cross-gate adversarial", () => {
  it("evaluates all gates when first gate (enabled) fails — no short-circuit", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: { ...baseConfig, enabled: false },
      securityScanHighCount: 5,
    });
    expect(r.gates[0].passed).toBe(false); // enabled fails
    const secGate = r.gates.find((g) => g.name === "security_scan");
    expect(secGate).toBeDefined();
    expect(secGate?.passed).toBe(false); // still evaluated
  });

  it("all optional gates failing simultaneously", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      config: { ...baseConfig, requireSelfReview: true },
      selfReviewResult: { score: 40, recommendation: "reject", concerns: ["bad"] },
      simulateRiskScore: 80,
      eapChainVerified: false,
      predictionRiskScore: 90,
      securityScanHighCount: 10,
      substrateReplayPassed: false,
      e2eStagingPassed: false,
    });
    expect(r.passed).toBe(false);
    expect(r.strategy).toBe("draft_pr");
    const failed = r.gates.filter((g) => !g.passed);
    expect(failed.length).toBeGreaterThanOrEqual(7); // self_review + 6 optional
  });

  it("gate evaluation order is deterministic", () => {
    const r1 = evaluateAutoMergeGates({ ...passingBase, securityScanHighCount: 0 });
    const r2 = evaluateAutoMergeGates({ ...passingBase, securityScanHighCount: 0 });
    expect(r1.gates.map((g) => g.name)).toEqual(r2.gates.map((g) => g.name));
  });

  it("optional gates appear only when provided, not when null", () => {
    const withAll = evaluateAutoMergeGates({
      ...passingBase,
      simulateRiskScore: 10,
      eapChainVerified: true,
      predictionRiskScore: 5,
    });
    const withNone = evaluateAutoMergeGates(passingBase);

    expect(withAll.gates.map((g) => g.name)).toContain("substrate_simulate");
    expect(withAll.gates.map((g) => g.name)).toContain("eap_chain_verified");
    expect(withNone.gates.map((g) => g.name)).not.toContain("substrate_simulate");
    expect(withNone.gates.map((g) => g.name)).not.toContain("eap_chain_verified");
  });

  it("handles extreme boundary values without crashing", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      confidenceScore: 0,
      linesChanged: Number.MAX_SAFE_INTEGER,
      simulateRiskScore: 100,
      predictionRiskScore: 100,
      securityScanHighCount: Number.MAX_SAFE_INTEGER,
    });
    expect(r.passed).toBe(false);
    expect(r.strategy).toBe("draft_pr");
    expect(r.gates.length).toBeGreaterThan(4);
  });

  it("confidence at exactly 0 fails gate", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, confidenceScore: 0 });
    expect(r.gates[2].passed).toBe(false);
  });

  it("security scan at exactly 0 passes gate", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, securityScanHighCount: 0 });
    const gate = r.gates.find((g) => g.name === "security_scan")!;
    expect(gate.passed).toBe(true);
  });
});

// ── Gate 12: fleet_verification (VAR Q2) ───────────────────────────────────

describe("Gate 12: fleet_verification", () => {
  it("no gate added when fleetVerification is null (not run yet)", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, fleetVerification: null });
    expect(r.gates.map((g) => g.name)).not.toContain("fleet_verification");
  });

  it("no gate added when totalSessions=0 (singleton alert)", () => {
    // Singleton alerts have no siblings to verify across. The single-
    // session What-If already covered them; fleet gate is skipped.
    const r = evaluateAutoMergeGates({
      ...passingBase,
      fleetVerification: { matchedPercent: 0, totalSessions: 0, threshold: 90 },
    });
    expect(r.gates.map((g) => g.name)).not.toContain("fleet_verification");
  });

  it("passes at exactly 90% (threshold boundary)", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      fleetVerification: { matchedPercent: 90, totalSessions: 100, threshold: 90 },
    });
    const gate = r.gates.find((g) => g.name === "fleet_verification")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toMatch(/90%.*100.*≥90%/);
  });

  it("passes at 100% (ideal)", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      fleetVerification: { matchedPercent: 100, totalSessions: 50, threshold: 90 },
    });
    const gate = r.gates.find((g) => g.name === "fleet_verification")!;
    expect(gate.passed).toBe(true);
  });

  it("fails at 89% (just below threshold)", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      fleetVerification: { matchedPercent: 89, totalSessions: 100, threshold: 90 },
    });
    const gate = r.gates.find((g) => g.name === "fleet_verification")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toMatch(/89%.*<90%/);
    expect(r.strategy).toBe("draft_pr");
  });

  it("fails at 0% (catastrophic)", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      fleetVerification: { matchedPercent: 0, totalSessions: 100, threshold: 90 },
    });
    const gate = r.gates.find((g) => g.name === "fleet_verification")!;
    expect(gate.passed).toBe(false);
    expect(r.passed).toBe(false);
  });

  it("honors custom threshold (80%)", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      fleetVerification: { matchedPercent: 85, totalSessions: 40, threshold: 80 },
    });
    const gate = r.gates.find((g) => g.name === "fleet_verification")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toMatch(/≥80%/);
  });

  it("circuit breaker bypass overrides fail", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      fleetVerification: { matchedPercent: 20, totalSessions: 100, threshold: 90 },
      circuitBreakerBypassed: new Set(["fleet_verification"]),
    });
    const gate = r.gates.find((g) => g.name === "fleet_verification")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toMatch(/CIRCUIT BREAKER/);
  });
});

// ── Gate 17: performance_regression (VAR Q2 Week 4) ────────────────────────

describe("Gate 17: performance_regression", () => {
  it("no gate added when performanceBenchmark is null", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, performanceBenchmark: null });
    expect(r.gates.map((g) => g.name)).not.toContain("performance_regression");
  });

  it("no gate added when regressionPercent is null (no http pairs)", () => {
    // Service with no HTTP request/response pairs — pure-DB job, pure-CPU
    // task. There's nothing to benchmark; gate should skip (not fail).
    const r = evaluateAutoMergeGates({
      ...passingBase,
      performanceBenchmark: { regressionPercent: null, thresholdPercent: 10, passed: null },
    });
    expect(r.gates.map((g) => g.name)).not.toContain("performance_regression");
  });

  it("passes when passed=true and regression is within threshold", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      performanceBenchmark: { regressionPercent: 5.3, thresholdPercent: 10, passed: true },
    });
    const gate = r.gates.find((g) => g.name === "performance_regression")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toMatch(/5\.3%.*≤10%/);
  });

  it("fails when regression exceeds threshold", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      performanceBenchmark: { regressionPercent: 22.7, thresholdPercent: 10, passed: false },
    });
    const gate = r.gates.find((g) => g.name === "performance_regression")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toMatch(/\+22\.7%.*10%/);
    expect(r.strategy).toBe("draft_pr");
  });

  it("passes when fix is FASTER (negative regression)", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      performanceBenchmark: { regressionPercent: -12.5, thresholdPercent: 10, passed: true },
    });
    const gate = r.gates.find((g) => g.name === "performance_regression")!;
    expect(gate.passed).toBe(true);
  });

  it("respects custom thresholdPercent", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      performanceBenchmark: { regressionPercent: 8.2, thresholdPercent: 5, passed: false },
    });
    const gate = r.gates.find((g) => g.name === "performance_regression")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toMatch(/5%/);
  });

  it("circuit breaker bypass overrides fail", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      performanceBenchmark: { regressionPercent: 50, thresholdPercent: 10, passed: false },
      circuitBreakerBypassed: new Set(["performance_regression"]),
    });
    const gate = r.gates.find((g) => g.name === "performance_regression")!;
    expect(gate.passed).toBe(true);
  });
});

// ── Gate 13: behavioral_drift (VAR Q2 Week 5) ──────────────────────────────

describe("Gate 13: behavioral_drift", () => {
  it("no gate added when behavioralDrift is null", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, behavioralDrift: null });
    expect(r.gates.map((g) => g.name)).not.toContain("behavioral_drift");
  });

  it("no gate added when passed is null (insufficient data / no replays)", () => {
    // No fleet replays, or every touched endpoint had <50 baseline samples.
    // There's nothing to measure — skip, don't fail.
    const r = evaluateAutoMergeGates({
      ...passingBase,
      behavioralDrift: {
        analyzedEndpoints: 0,
        driftedEndpoints: 0,
        improvedEndpoints: 0,
        thresholdDriftedPercent: 20,
        passed: null,
      },
    });
    expect(r.gates.map((g) => g.name)).not.toContain("behavioral_drift");
  });

  it("passes when drifted_percent is within threshold", () => {
    // 2 of 20 endpoints drifted = 10% — under the 20% threshold.
    const r = evaluateAutoMergeGates({
      ...passingBase,
      behavioralDrift: {
        analyzedEndpoints: 20,
        driftedEndpoints: 2,
        improvedEndpoints: 3,
        thresholdDriftedPercent: 20,
        passed: true,
      },
    });
    const gate = r.gates.find((g) => g.name === "behavioral_drift")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toMatch(/2\/20.*10\.0%/);
  });

  it("fails when drifted_percent exceeds threshold", () => {
    // 5 of 10 endpoints drifted = 50% — way over 20% threshold.
    const r = evaluateAutoMergeGates({
      ...passingBase,
      behavioralDrift: {
        analyzedEndpoints: 10,
        driftedEndpoints: 5,
        improvedEndpoints: 0,
        thresholdDriftedPercent: 20,
        passed: false,
      },
    });
    const gate = r.gates.find((g) => g.name === "behavioral_drift")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toMatch(/5\/10.*50\.0%.*20%/);
    expect(r.strategy).toBe("draft_pr");
  });

  it("passes when zero endpoints drifted (ideal case)", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      behavioralDrift: {
        analyzedEndpoints: 15,
        driftedEndpoints: 0,
        improvedEndpoints: 4,
        thresholdDriftedPercent: 20,
        passed: true,
      },
    });
    const gate = r.gates.find((g) => g.name === "behavioral_drift")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toMatch(/\+4 improved/);
  });

  it("improvements are cosmetic — they do NOT fail the gate", () => {
    // Yellow light semantics: even with 30 improvements, if NO endpoints
    // drifted, the gate passes. Improvements are a cosmetic signal only.
    const r = evaluateAutoMergeGates({
      ...passingBase,
      behavioralDrift: {
        analyzedEndpoints: 50,
        driftedEndpoints: 3,
        improvedEndpoints: 30,
        thresholdDriftedPercent: 20,
        passed: true,
      },
    });
    const gate = r.gates.find((g) => g.name === "behavioral_drift")!;
    expect(gate.passed).toBe(true);
  });

  it("improvements annotation omitted when zero", () => {
    // Don't pollute the reason line with "(+0 improved)".
    const r = evaluateAutoMergeGates({
      ...passingBase,
      behavioralDrift: {
        analyzedEndpoints: 10,
        driftedEndpoints: 1,
        improvedEndpoints: 0,
        thresholdDriftedPercent: 20,
        passed: true,
      },
    });
    const gate = r.gates.find((g) => g.name === "behavioral_drift")!;
    expect(gate.reason).not.toMatch(/improved/);
  });

  it("respects custom thresholdDriftedPercent", () => {
    // Strict workspace setting — 10% threshold instead of default 20%.
    const r = evaluateAutoMergeGates({
      ...passingBase,
      behavioralDrift: {
        analyzedEndpoints: 10,
        driftedEndpoints: 2,
        improvedEndpoints: 0,
        thresholdDriftedPercent: 10,
        passed: false,
      },
    });
    const gate = r.gates.find((g) => g.name === "behavioral_drift")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toMatch(/10%/);
  });

  it("circuit breaker bypass overrides fail", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      behavioralDrift: {
        analyzedEndpoints: 10,
        driftedEndpoints: 8,
        improvedEndpoints: 0,
        thresholdDriftedPercent: 20,
        passed: false,
      },
      circuitBreakerBypassed: new Set(["behavioral_drift"]),
    });
    const gate = r.gates.find((g) => g.name === "behavioral_drift")!;
    expect(gate.passed).toBe(true);
  });
});

// ── Gate 15: compliance (VAR Q2 Week 7) ────────────────────────────────────

describe("Gate 15: compliance", () => {
  it("no gate added when complianceScan is null", () => {
    const r = evaluateAutoMergeGates({ ...passingBase, complianceScan: null });
    expect(r.gates.map((g) => g.name)).not.toContain("compliance");
  });

  it("passes when zero violations across all categories", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      complianceScan: {
        highCount: 0, totalViolations: 0,
        gdprCount: 0, soc2Count: 0, pciCount: 0,
      },
    });
    const gate = r.gates.find((g) => g.name === "compliance")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toMatch(/no GDPR\/SOC2\/PCI violations/);
  });

  it("passes when only MEDIUM/LOW findings exist (no HIGH)", () => {
    // Yellow-light cousin of Gate 13 — medium findings are surfaced for
    // review but don't fail the merge. E.g., an email column that may
    // be encrypted at the app layer.
    const r = evaluateAutoMergeGates({
      ...passingBase,
      complianceScan: {
        highCount: 0, totalViolations: 3,
        gdprCount: 2, soc2Count: 1, pciCount: 0,
      },
    });
    const gate = r.gates.find((g) => g.name === "compliance")!;
    expect(gate.passed).toBe(true);
    expect(gate.reason).toMatch(/3 medium\/low to review/);
    expect(gate.reason).toMatch(/GDPR 2/);
    expect(gate.reason).toMatch(/SOC2 1/);
  });

  it("fails when any HIGH violation is introduced", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      complianceScan: {
        highCount: 1, totalViolations: 2,
        gdprCount: 0, soc2Count: 0, pciCount: 1,
      },
    });
    const gate = r.gates.find((g) => g.name === "compliance")!;
    expect(gate.passed).toBe(false);
    expect(gate.reason).toMatch(/1 HIGH severity violation/);
    expect(gate.reason).toMatch(/PCI 1/);
    expect(r.strategy).toBe("draft_pr");
  });

  it("emits a breakdown chip per non-zero regulation", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      complianceScan: {
        highCount: 3, totalViolations: 3,
        gdprCount: 1, soc2Count: 1, pciCount: 1,
      },
    });
    const reason = r.gates.find((g) => g.name === "compliance")!.reason;
    expect(reason).toMatch(/GDPR 1.*SOC2 1.*PCI 1/);
  });

  it("omits a regulation from the breakdown when count is zero", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      complianceScan: {
        highCount: 1, totalViolations: 1,
        gdprCount: 0, soc2Count: 0, pciCount: 1,
      },
    });
    const reason = r.gates.find((g) => g.name === "compliance")!.reason;
    expect(reason).not.toMatch(/GDPR/);
    expect(reason).not.toMatch(/SOC2/);
    expect(reason).toMatch(/PCI/);
  });

  it("circuit breaker bypass overrides fail", () => {
    const r = evaluateAutoMergeGates({
      ...passingBase,
      complianceScan: {
        highCount: 5, totalViolations: 7,
        gdprCount: 2, soc2Count: 2, pciCount: 3,
      },
      circuitBreakerBypassed: new Set(["compliance"]),
    });
    const gate = r.gates.find((g) => g.name === "compliance")!;
    expect(gate.passed).toBe(true);
  });
});
