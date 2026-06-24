/**
 * Auto-merge gate producers (Fase 8).
 *
 * A "producer" is the async computation that yields a gate's input value
 * for `evaluateAutoMergeGates()`. Producers are the I/O-bound steps
 * (AI calls, DB queries, external waits). The evaluator itself is a pure
 * sync function — see `auto-merge-gates.ts`.
 *
 * This file centralizes:
 *   - The ProducerSpec type (name + dependsOn + run).
 *   - Placeholder producers for the Q2 gates that are declared in
 *     `auto-merge-gates.ts` but not yet wired into any caller. They return
 *     null so the evaluator skips them cleanly. When a Q2 gate gets a real
 *     implementation, swap the placeholder body — no topology change needed.
 *
 * The real Level 1 / Level 3 producers (security_scan, self_review,
 * substrate_replay, substrate_simulate, eap_chain_verified) remain inline
 * in `remediate.ts` — they close over local state (aiKey, session,
 * fix.files, fileContents, ...) and extracting them would inflate the
 * surface area of this refactor without changing wall-time behavior.
 *
 * See `web/docs/gates-dependency.md` for the full DAG and level assignments.
 */

/** Shape of every gate producer: a name for telemetry, its upstream deps, and a run fn. */
export type ProducerSpec<T> = {
  name: string;
  dependsOn: readonly string[];
  run: () => Promise<T>;
};

/**
 * Read the GATES_PARALLEL feature flag. When false (default), the executor
 * runs producers in the original serial order so behavior matches pre-Fase 8
 * exactly. Flip to "true" in Vercel/Hetzner env to enable parallelization.
 */
export function isGatesParallelEnabled(): boolean {
  return process.env.GATES_PARALLEL === "true";
}

// ── Q2 placeholder producers ────────────────────────────────────────────────
//
// These gates are declared in `auto-merge-gates.ts` (params type) but the
// current `remediate.ts` pipeline does not compute them. We expose null-
// returning producers here so that:
//   1. The DAG topology already includes them — when wiring lands, the caller
//      just swaps the body of the placeholder and existing tests continue to
//      exercise the DAG shape.
//   2. Nothing in the pipeline today regresses — `evaluateAutoMergeGates`
//      skips (no gate row emitted) when its input is null.
//
// Each placeholder documents its future Level assignment.

/** Q2 Gate 14 — Cost Impact. Level 4. Aggregates ai_usage_logs.cost_usd for the session. */
export const costImpactPlaceholder: ProducerSpec<null> = {
  name: "cost_impact",
  dependsOn: ["security_scan", "self_review", "substrate_replay"], // all L1 AI logs must exist
  run: async () => null,
};

/** Q2 Gate 12 — Fleet Verification. Level 3. Requires post-push branch + fleet replay. */
export const fleetVerificationPlaceholder: ProducerSpec<null> = {
  name: "fleet_verification",
  dependsOn: ["ci_passed"],
  run: async () => null,
};

/** Q2 Gate 13 — Behavioral Drift. Level 3. Drift analysis vs 7d rolling baseline. */
export const behavioralDriftPlaceholder: ProducerSpec<null> = {
  name: "behavioral_drift",
  dependsOn: ["ci_passed"],
  run: async () => null,
};

/** Q2 Gate 15 — Compliance Scan. Level 1. Regex scan over fix diff (GDPR/SOC2/PCI). */
export const complianceScanPlaceholder: ProducerSpec<null> = {
  name: "compliance_scan",
  dependsOn: [],
  run: async () => null,
};

/** Q2 Gate 16 — Multi-environment Coverage. Level 3. Depends on fleet replay env data. */
export const multiEnvCoveragePlaceholder: ProducerSpec<null> = {
  name: "multi_env_coverage",
  dependsOn: ["fleet_verification"],
  run: async () => null,
};

/** Q2 Gate 17 — Performance Regression. Level 3. Benchmark replayed vs recorded latency. */
export const performanceRegressionPlaceholder: ProducerSpec<null> = {
  name: "performance_regression",
  dependsOn: ["ci_passed"],
  run: async () => null,
};

/** Prediction engine — not yet wired into `remediate.ts`. Level 1 when wired. */
export const predictionSafePlaceholder: ProducerSpec<null> = {
  name: "prediction_safe",
  dependsOn: [],
  run: async () => null,
};
