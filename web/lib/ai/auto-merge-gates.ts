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

export function evaluateAutoMergeGates(params: {
  config: AutoMergeConfig;
  confidenceScore: number;
  selfReviewResult: SelfReviewResult | null;
  linesChanged: number;
  ciPassed: boolean;
  simulateRiskScore?: number | null;
  eapChainVerified?: boolean | null;
}): GateResult {
  const { config, confidenceScore, selfReviewResult, linesChanged, ciPassed, simulateRiskScore, eapChainVerified } = params;
  const gates: GateResult["gates"] = [];

  // Gate 0: Auto-merge must be enabled
  gates.push({
    name: "auto_merge_enabled",
    passed: config.enabled,
    reason: config.enabled ? "Auto-merge is enabled for this project" : "Auto-merge is not enabled",
  });

  // Gate 1: CI must pass
  gates.push({
    name: "ci_passed",
    passed: ciPassed,
    reason: ciPassed ? "All CI checks passed" : "CI checks failed",
  });

  // Gate 2: Confidence score
  const confidencePassed = confidenceScore >= config.minConfidence;
  gates.push({
    name: "confidence",
    passed: confidencePassed,
    reason: confidencePassed
      ? `Confidence ${confidenceScore}% >= ${config.minConfidence}% threshold`
      : `Confidence ${confidenceScore}% < ${config.minConfidence}% threshold`,
  });

  // Gate 3: Lines changed
  const linesPassed = linesChanged <= config.maxLinesChanged;
  gates.push({
    name: "lines_changed",
    passed: linesPassed,
    reason: linesPassed
      ? `${linesChanged} lines changed <= ${config.maxLinesChanged} max`
      : `${linesChanged} lines changed > ${config.maxLinesChanged} max`,
  });

  // Gate 4: Self-review (if required)
  if (config.requireSelfReview) {
    const reviewPassed = selfReviewResult !== null
      && selfReviewResult.recommendation !== "reject"
      && selfReviewResult.score >= 70;
    gates.push({
      name: "self_review",
      passed: reviewPassed,
      reason: selfReviewResult
        ? `Self-review: ${selfReviewResult.score}/100, recommendation: ${selfReviewResult.recommendation}${selfReviewResult.concerns.length > 0 ? ` (${selfReviewResult.concerns.length} concern${selfReviewResult.concerns.length > 1 ? "s" : ""})` : ""}`
        : "Self-review not completed",
    });
  }

  // Gate 5: Substrate simulate risk (if recording data available)
  if (simulateRiskScore != null) {
    const simulatePassed = simulateRiskScore <= 40; // Block if HIGH or CRITICAL (>40)
    gates.push({
      name: "substrate_simulate",
      passed: simulatePassed,
      reason: simulatePassed
        ? `Substrate simulate risk score ${simulateRiskScore}/100 (safe)`
        : `Substrate simulate risk score ${simulateRiskScore}/100 exceeds threshold (>40)`,
    });
  }

  // Gate 6: EAP chain verification (if receipt data available)
  if (eapChainVerified != null) {
    gates.push({
      name: "eap_chain_verified",
      passed: eapChainVerified,
      reason: eapChainVerified
        ? "EAP execution receipt chain verified — all signatures valid"
        : "EAP execution receipt chain verification failed",
    });
  }

  const allPassed = gates.every((g) => g.passed);

  return {
    passed: allPassed,
    gates,
    strategy: allPassed ? "auto_merge" : "draft_pr",
  };
}
