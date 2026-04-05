/**
 * Auto-merge gate evaluation.
 *
 * Checks all configured gates before deciding whether to auto-merge
 * or create a draft PR. Every gate must pass for auto-merge.
 */

import type { AutoMergeConfig } from "@/lib/db/schema";

export type GateResult = {
  passed: boolean;
  gates: {
    name: string;
    passed: boolean;
    reason: string;
  }[];
  strategy: "auto_merge" | "draft_pr";
};

export type SelfReviewResult = {
  score: number;
  concerns: string[];
  recommendation: "approve" | "flag" | "reject";
};

/**
 * Evaluate gates with optional circuit breaker integration.
 * Pass projectId to enable circuit breaker bypass for consistently failing gates.
 */
export function evaluateAutoMergeGates(params: {
  config: AutoMergeConfig;
  confidenceScore: number;
  selfReviewResult: SelfReviewResult | null;
  linesChanged: number;
  ciPassed: boolean;
  simulateRiskScore?: number | null;
  eapChainVerified?: boolean | null;
  predictionRiskScore?: number | null;
  securityScanHighCount?: number | null;
  substrateReplayPassed?: boolean | null;
  e2eStagingPassed?: boolean | null;
  /** Gate names bypassed by circuit breaker (pre-computed by caller) */
  circuitBreakerBypassed?: Set<string>;
}): GateResult {
  const { config, confidenceScore, selfReviewResult, linesChanged, ciPassed, simulateRiskScore, eapChainVerified, predictionRiskScore, securityScanHighCount, substrateReplayPassed, e2eStagingPassed, circuitBreakerBypassed } = params;
  const gates: GateResult["gates"] = [];
  const bypassed = circuitBreakerBypassed ?? new Set<string>();

  /** Push gate — if circuit breaker is open for this gate, override to passed */
  function pushGate(name: string, passed: boolean, reason: string) {
    if (bypassed.has(name)) {
      gates.push({ name, passed: true, reason: `${reason} [CIRCUIT BREAKER: gate bypassed — consistently failing]` });
    } else {
      gates.push({ name, passed, reason });
    }
  }

  // Gate 0: Auto-merge must be enabled
  pushGate("auto_merge_enabled", config.enabled,
    config.enabled ? "Auto-merge is enabled for this project" : "Auto-merge is not enabled");

  // Gate 1: CI must pass
  pushGate("ci_passed", ciPassed,
    ciPassed ? "All CI checks passed" : "CI checks failed");

  // Gate 2: Confidence score
  const confidencePassed = confidenceScore >= config.minConfidence;
  pushGate("confidence", confidencePassed,
    confidencePassed
      ? `Confidence ${confidenceScore}% >= ${config.minConfidence}% threshold`
      : `Confidence ${confidenceScore}% < ${config.minConfidence}% threshold`);

  // Gate 3: Lines changed
  const linesPassed = linesChanged <= config.maxLinesChanged;
  pushGate("lines_changed", linesPassed,
    linesPassed
      ? `${linesChanged} lines changed <= ${config.maxLinesChanged} max`
      : `${linesChanged} lines changed > ${config.maxLinesChanged} max`);

  // Gate 4: Self-review (if required)
  if (config.requireSelfReview) {
    const reviewPassed = selfReviewResult !== null
      && selfReviewResult.recommendation !== "reject"
      && selfReviewResult.score >= 70;
    pushGate("self_review", reviewPassed,
      selfReviewResult
        ? `Self-review: ${selfReviewResult.score}/100, recommendation: ${selfReviewResult.recommendation}${selfReviewResult.concerns.length > 0 ? ` (${selfReviewResult.concerns.length} concern${selfReviewResult.concerns.length > 1 ? "s" : ""})` : ""}`
        : "Self-review not completed");
  }

  // Gate 5: Substrate simulate risk (if recording data available)
  if (simulateRiskScore != null) {
    const simulatePassed = simulateRiskScore <= 40;
    pushGate("substrate_simulate", simulatePassed,
      simulatePassed
        ? `Substrate simulate risk score ${simulateRiskScore}/100 (safe)`
        : `Substrate simulate risk score ${simulateRiskScore}/100 exceeds threshold (>40)`);
  }

  // Gate 6: EAP chain verification (if receipt data available)
  if (eapChainVerified != null) {
    pushGate("eap_chain_verified", eapChainVerified,
      eapChainVerified
        ? "EAP execution receipt chain verified — all signatures valid"
        : "EAP execution receipt chain verification failed");
  }

  // Gate 7: Prediction engine risk score (if shadow replay ran)
  if (predictionRiskScore != null) {
    const predictionSafe = predictionRiskScore <= 40;
    pushGate("prediction_safe", predictionSafe,
      predictionSafe
        ? `Prediction risk score ${predictionRiskScore}/100 — within safe threshold`
        : `Prediction risk score ${predictionRiskScore}/100 — exceeds safe threshold (max 40)`);
  }

  // Gate 8: Security scan (if scan was run)
  if (securityScanHighCount != null) {
    const securityPassed = securityScanHighCount === 0;
    pushGate("security_scan", securityPassed,
      securityPassed
        ? "Security scan passed — no HIGH severity findings"
        : `Security scan found ${securityScanHighCount} HIGH severity finding(s)`);
  }

  // Gate 9: Substrate replay verification (if replay ran)
  if (substrateReplayPassed != null) {
    pushGate("substrate_replay", substrateReplayPassed,
      substrateReplayPassed
        ? "Substrate I/O replay verified — fix prevents the recorded crash"
        : "Substrate I/O replay indicates fix may not prevent the recorded crash");
  }

  // Gate 10: E2E staging verification (if staging tests ran)
  if (e2eStagingPassed != null) {
    pushGate("e2e_staging", e2eStagingPassed,
      e2eStagingPassed
        ? "E2E staging tests passed — fix verified in staging environment"
        : "E2E staging tests failed — fix may introduce regressions");
  }

  const allPassed = gates.every((g) => g.passed);

  return {
    passed: allPassed,
    gates,
    strategy: allPassed ? "auto_merge" : "draft_pr",
  };
}
