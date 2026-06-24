/**
 * Code Intelligence v2 — Phase 3.3 cutover criteria.
 *
 * Single source of truth for the GO/WAIT/ABORT thresholds. Loaded by:
 *   - web/scripts/code-intel-v2-cutover-eval.ts (the CLI)
 *   - web/app/api/admin/code-intel/cutover-status/route.ts (the endpoint)
 *   - web/app/(dashboard)/admin/ops/widgets/code-intel-cutover.tsx (UI hints)
 *
 * Per CODE_INTELLIGENCE_V2_HANDOFF.md §3.3.
 *
 * Tweaking a threshold? Update __tests__/cutover-eval.test.ts to match.
 */

/** Minimum number of A/B rows before the script will give a verdict. */
export const CUTOVER_MIN_SAMPLES = 100;

/** v2 must reduce avg turns by AT LEAST this percent. */
export const CUTOVER_TURN_REDUCTION_PCT = 30;

/**
 * v2 success rate must be NO MORE than this many percentage points BELOW
 * v1. -2 means "v2 may be up to 2pp lower than v1; anything worse aborts".
 */
export const CUTOVER_SUCCESS_PARITY_PCT = -2;

/** Shadow divergence (top-FQN mismatch) must be at most this percent. */
export const CUTOVER_DIVERGENCE_MAX_PCT = 25;

/** Window the script + endpoint look back over (hours). */
export const CUTOVER_WINDOW_HOURS = 24 * 14; // 14 days
