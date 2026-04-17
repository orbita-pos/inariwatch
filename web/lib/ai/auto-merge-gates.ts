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
  /** True when the Substrate replay analysis was enriched with a Replay V2 frontend session (user journey + causal chain). */
  substrateReplayUsedFrontendContext?: boolean | null;
  e2eStagingPassed?: boolean | null;
  /** Whether the fix was verified (tsc + build) inside a container before push. */
  containerVerified?: boolean | null;
  /** VAR Q2 — Gate 12. Fleet verification result. Shape:
   *    - null:           no fleet run exists yet (gate informational-only)
   *    - { ..., totalSessions: 0 }: singleton alert, no siblings to verify
   *    - { passedPercent, totalSessions }: pass/fail on the ≥90% threshold
   */
  fleetVerification?: {
    matchedPercent: number;
    totalSessions: number;
    threshold: number;
  } | null;
  /** VAR Q2 — Gate 17. Performance regression result. Shape:
   *    - null:                              no benchmark run yet
   *    - { regressionPercent: null }:       no HTTP pairs to measure (skip)
   *    - { regressionPercent, threshold }:  pass/fail vs threshold
   */
  performanceBenchmark?: {
    regressionPercent: number | null;
    thresholdPercent: number;
    passed: boolean | null;
  } | null;
  /** VAR Q2 — Gate 13. Behavioral drift result. Shape:
   *    - null:              no drift run yet (gate not evaluated)
   *    - { passed: null }:  nothing to analyze (no fleet replays, no
   *                         endpoints extracted, or every touched endpoint
   *                         had <50 baseline samples → insufficient_data)
   *    - { passed, ... }:   pass/fail on drifted_percent threshold
   *  Permissive calibration — structural drift flags an endpoint but does
   *  not dominate the overall score. Yellow light — improvements_detected
   *  is informational only and never fails the gate.
   */
  behavioralDrift?: {
    driftedEndpoints: number;
    analyzedEndpoints: number;
    improvedEndpoints: number;
    thresholdDriftedPercent: number;
    passed: boolean | null;
  } | null;
  /** VAR Q2 — Gate 15. Compliance scan result. Shape:
   *    - null:                    scan not run (gate skipped)
   *    - { highCount, total... }: pass/fail on HIGH-severity count
   *  Passes when highCount === 0. Medium/low never fail the gate —
   *  they're surfaced to the reviewer but need human context (e.g.,
   *  an email column may be encrypted at the app layer).
   */
  complianceScan?: {
    highCount: number;
    totalViolations: number;
    gdprCount: number;
    soc2Count: number;
    pciCount: number;
  } | null;
  /** VAR Q2 — Gate 16. Multi-environment coverage. Shape:
   *    - null:                       gate not run
   *    - { passed: null, skipReason }: skipped (single-env, fleet
   *                                     incomplete, or no env data).
   *                                     Auto-merge treats as SKIP.
   *    - { passed, ... }:            pass/fail on missing_envs_high.
   *  Evidence-based — compares fleet replay envs (from Gate 12) against
   *  the project's runtime distribution over the window. Missing env
   *  above 20% traffic fails; 10-20% surfaces but doesn't fail.
   */
  multiEnvCoverage?: {
    passed: boolean | null;
    missingEnvsHigh: string[];
    missingEnvsMedium: string[];
    coveragePercent: number | null;
    skipReason: string | null;
  } | null;
  /** VAR Q2 — Gate 14. Cost Impact. Shape:
   *    - null:              scan not run (gate skipped)
   *    - { passed: null }:  no ai_usage_logs for this remediation (skip)
   *    - { passed, ... }:   pass/fail on remediationCostUsd vs thresholdUsd
   *  Evidence-based — aggregates ai_usage_logs.cost_usd by
   *  remediation_session_id. Passes when total <= threshold.
   */
  costImpact?: {
    passed: boolean | null;
    remediationCostUsd: number;
    thresholdUsd: number;
    callCount: number;
  } | null;
  /** Gate names bypassed by circuit breaker (pre-computed by caller) */
  circuitBreakerBypassed?: Set<string>;
}): GateResult {
  const { config, confidenceScore, selfReviewResult, linesChanged, ciPassed, simulateRiskScore, eapChainVerified, predictionRiskScore, securityScanHighCount, substrateReplayPassed, substrateReplayUsedFrontendContext, e2eStagingPassed, containerVerified, fleetVerification, performanceBenchmark, behavioralDrift, complianceScan, multiEnvCoverage, costImpact, circuitBreakerBypassed } = params;
  const gates: GateResult["gates"] = [];
  const bypassed = circuitBreakerBypassed ?? new Set<string>();

  /** Push gate — if circuit breaker is open for this gate, override to passed.
   *  If too many gates are simultaneously bypassed, the caller should downgrade to draft_pr. */
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

  // Gate 9: Substrate replay verification (if replay ran). When the analysis
  // also pulled in the Replay V2 frontend session, the reason is enriched —
  // the verdict itself is already factored into `substrateReplayPassed`.
  if (substrateReplayPassed != null) {
    const passReason = substrateReplayUsedFrontendContext
      ? "Substrate I/O replay verified with frontend user journey — fix addresses the full click → HTTP → DB chain"
      : "Substrate I/O replay verified — fix prevents the recorded crash";
    const failReason = substrateReplayUsedFrontendContext
      ? "Substrate I/O replay (with frontend journey) indicates fix may not prevent the recorded crash"
      : "Substrate I/O replay indicates fix may not prevent the recorded crash";
    pushGate("substrate_replay", substrateReplayPassed, substrateReplayPassed ? passReason : failReason);
  }

  // Gate 10: E2E staging verification (if staging tests ran)
  if (e2eStagingPassed != null) {
    pushGate("e2e_staging", e2eStagingPassed,
      e2eStagingPassed
        ? "E2E staging tests passed — fix verified in staging environment"
        : "E2E staging tests failed — fix may introduce regressions");
  }

  // Gate 11: Container verification (if fix was verified in container)
  // This gate is informational — always passes when present. Its purpose is to
  // boost confidence in the gate audit trail (fix was compiled + built before push).
  if (containerVerified != null) {
    pushGate("container_verified", containerVerified,
      containerVerified
        ? "Fix verified in container — tsc and build passed before push"
        : "Container verification ran but tsc/build failed");
  }

  // Gate 12: Fleet verification (VAR Q2 — What-If Across Fleet)
  // Passes when ≥90% of affected sessions are predicted to be protected.
  // Skipped (no gate row) when no fleet run exists OR the alert is a
  // singleton (totalSessions=0) — in both cases the single-session
  // verification carries the load.
  if (fleetVerification != null && fleetVerification.totalSessions > 0) {
    const pct = fleetVerification.matchedPercent;
    const threshold = fleetVerification.threshold;
    const fleetPassed = pct >= threshold;
    pushGate("fleet_verification", fleetPassed,
      fleetPassed
        ? `Fleet verification: ${pct}% of ${fleetVerification.totalSessions} sessions protected (≥${threshold}% threshold)`
        : `Fleet verification: only ${pct}% of ${fleetVerification.totalSessions} sessions protected (<${threshold}% threshold)`);
  }

  // Gate 17: Performance regression (VAR Q2 Week 4)
  // Compares replayed-event latency (fix) vs recorded-event latency
  // (baseline) from whatif_replays.substrate. Passes when p50
  // regression is at or below thresholdPercent (default 10%).
  // Skipped (no gate row) when:
  //   - no benchmark exists
  //   - benchmark found no HTTP pairs (pure-DB services,
  //     regressionPercent=null). In that case there's nothing to measure
  //     so the gate can't meaningfully pass or fail.
  if (
    performanceBenchmark != null &&
    performanceBenchmark.regressionPercent != null &&
    performanceBenchmark.passed != null
  ) {
    const pct = performanceBenchmark.regressionPercent;
    const threshold = performanceBenchmark.thresholdPercent;
    pushGate("performance_regression", performanceBenchmark.passed,
      performanceBenchmark.passed
        ? `Performance benchmark: p50 regression ${pct.toFixed(1)}% within threshold (≤${threshold}%)`
        : `Performance regression: p50 +${pct.toFixed(1)}% exceeds threshold (${threshold}%)`);
  }

  // Gate 13: Behavioral drift (VAR Q2 Week 5)
  // Compares fix's replay I/O against the 7d rolling baseline of healthy
  // production recordings. Yellow-light: improvements are informational,
  // only drifted_percent > threshold fails the gate. Permissive calibration:
  // structural changes flag the endpoint but don't dominate the score.
  // Skipped (no gate row) when:
  //   - no drift run exists
  //   - run completed with passed=null (no fleet replays, zero endpoints
  //     extracted, or every touched endpoint was insufficient_data). There's
  //     nothing to measure so the gate can't meaningfully pass or fail.
  if (behavioralDrift != null && behavioralDrift.passed != null) {
    const { driftedEndpoints, analyzedEndpoints, improvedEndpoints, thresholdDriftedPercent } = behavioralDrift;
    const pct = analyzedEndpoints > 0
      ? (driftedEndpoints / analyzedEndpoints) * 100
      : 0;
    const improvementsNote = improvedEndpoints > 0
      ? ` (+${improvedEndpoints} improved)`
      : "";
    pushGate("behavioral_drift", behavioralDrift.passed,
      behavioralDrift.passed
        ? `Behavioral drift: ${driftedEndpoints}/${analyzedEndpoints} endpoints drifted (${pct.toFixed(1)}% ≤ ${thresholdDriftedPercent}% threshold)${improvementsNote}`
        : `Behavioral drift: ${driftedEndpoints}/${analyzedEndpoints} endpoints drifted (${pct.toFixed(1)}% > ${thresholdDriftedPercent}% threshold)${improvementsNote}`);
  }

  // Gate 15: Compliance scan (VAR Q2 Week 7)
  // Regex-based static scan over the fix diff for GDPR/SOC2/PCI DSS
  // violations (lib/ai/compliance-scan.ts, 19 rules). Passes when zero
  // HIGH-severity findings are introduced. MEDIUM/LOW findings are
  // informational and do NOT fail the gate — they need human context
  // (e.g., an email column may be encrypted at the app layer).
  // Skipped (no gate row) when the scan wasn't run.
  if (complianceScan != null) {
    const compliancePassed = complianceScan.highCount === 0;
    const breakdown = [
      complianceScan.gdprCount > 0 ? `GDPR ${complianceScan.gdprCount}` : null,
      complianceScan.soc2Count > 0 ? `SOC2 ${complianceScan.soc2Count}` : null,
      complianceScan.pciCount > 0 ? `PCI ${complianceScan.pciCount}` : null,
    ].filter(Boolean).join(", ");
    pushGate("compliance", compliancePassed,
      compliancePassed
        ? complianceScan.totalViolations === 0
          ? "Compliance scan passed — no GDPR/SOC2/PCI violations introduced"
          : `Compliance scan passed — 0 HIGH findings (${complianceScan.totalViolations} medium/low to review${breakdown ? `: ${breakdown}` : ""})`
        : `Compliance scan found ${complianceScan.highCount} HIGH severity violation(s)${breakdown ? ` (${breakdown})` : ""}`);
  }

  // Gate 16: Multi-environment coverage (VAR Q2 Week 8)
  // Compares fleet-replay env distribution against project runtime
  // distribution. Passes when no HIGH-severity missing envs (>20%
  // traffic missing from fleet). MEDIUM misses (10-20%) surface but
  // don't fail — yellow-light, same spirit as Gate 13 + Gate 15.
  // Skipped (no gate row) when:
  //   - no multiEnvCoverage data
  //   - passed is null (single-env project, fleet incomplete, or no env
  //     data from Capture SDK) — skipReason explains why in the UI.
  if (multiEnvCoverage != null && multiEnvCoverage.passed != null) {
    const { missingEnvsHigh, missingEnvsMedium, coveragePercent } = multiEnvCoverage;
    const mediumNote = missingEnvsMedium.length > 0
      ? ` (review ${missingEnvsMedium.length} medium)`
      : "";
    const coverageLabel = coveragePercent !== null
      ? `${coveragePercent.toFixed(1)}% traffic covered`
      : "coverage n/a";
    pushGate("multi_env_coverage", multiEnvCoverage.passed,
      multiEnvCoverage.passed
        ? `Multi-env coverage: ${coverageLabel}${mediumNote}`
        : `Multi-env coverage gap: ${missingEnvsHigh.length} env(s) >20% traffic missing from fleet replay (${missingEnvsHigh.join(", ")})${mediumNote}`);
  }

  // Gate 14: Cost Impact (VAR Q2 Week 9)
  // Aggregates AI spend across every ai_usage_logs row for this
  // remediation (diagnose + self-review + security-scan + fix gen).
  // Passes when total cost <= threshold (default $1 USD). Skipped
  // (no gate row) when:
  //   - no costImpact data
  //   - passed is null (ai_usage_logs empty — AI path wasn't logged,
  //     e.g. BYOK user with telemetry disabled). Auto-merge treats
  //     as skip, not fail — same contract as Gate 15/16.
  if (costImpact != null && costImpact.passed != null) {
    const cost = costImpact.remediationCostUsd;
    const threshold = costImpact.thresholdUsd;
    const costLabel = `$${cost.toFixed(4)}`;
    const thresholdLabel = `$${threshold.toFixed(2)}`;
    pushGate("cost_impact", costImpact.passed,
      costImpact.passed
        ? `Cost impact: ${costLabel} in ${costImpact.callCount} call(s) — within budget (≤${thresholdLabel})`
        : `Cost impact: ${costLabel} in ${costImpact.callCount} call(s) — exceeds budget (>${thresholdLabel})`);
  }

  const allPassed = gates.every((g) => g.passed);

  return {
    passed: allPassed,
    gates,
    strategy: allPassed ? "auto_merge" : "draft_pr",
  };
}
