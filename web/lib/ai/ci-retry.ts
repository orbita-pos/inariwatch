/**
 * Fase 4 Part C — intelligent CI retry policy.
 *
 * Pure helpers extracted from remediate.ts so the retry decision is
 * trivially testable without mocking the entire remediation pipeline.
 *
 * Policy: when pre-push hooks verified the fix green locally AND the
 * webhook-driven CI monitoring is enabled, a GitHub CI failure is
 * statistically most likely flake (env-specific data, network, runner
 * caching). We re-push the SAME fix up to 3 times with 30s / 2m / 5m
 * backoff. Only active when BOTH flags are on — a missing prepush signal
 * cannot distinguish flake from genuinely broken code.
 */

/** Backoff in milliseconds per retry attempt, 0-indexed.
 *  attempts[0]=30s, attempts[1]=2m, attempts[2]=5m. Exposed for tests. */
export const CI_FLAKE_BACKOFF_MS: readonly number[] = [30_000, 120_000, 300_000];

/** Maximum number of flake retries before falling through to regenerate. */
export const CI_FLAKE_MAX_RETRIES = 3;

export interface CiRetryState {
  /** Final CI status from gh.getCheckRunsStatus. */
  ciStatus: "success" | "failure" | "pending" | "in_progress";
  /** PREPUSH_TESTS_ENABLED === 'true' */
  prepushEnabled: boolean;
  /** CI_WEBHOOK_MODE === 'true' */
  ciWebhookEnabled: boolean;
  /**
   * True when the worker's pre-push hooks actually ran AND passed.
   * null when pre-push didn't run (flag off, old worker, Vercel fallback).
   * false when they ran and failed — unreachable in practice because the
   * worker loops back to apply_patch in that case, but handled for safety.
   */
  prepushPassed: boolean | null;
  /** Number of flake retries attempted so far (0 before first retry). */
  flakeAttempts: number;
  /** Number of files in the fix — a prereq for re-pushing from our side. */
  fileCount: number;
}

/**
 * Decide whether the current CI failure should trigger a flake retry
 * rather than the existing "regenerate the fix from scratch" path.
 */
export function shouldRetryCiFlake(state: CiRetryState): boolean {
  if (state.ciStatus !== "failure") return false;
  if (!state.prepushEnabled) return false;
  if (!state.ciWebhookEnabled) return false;
  if (state.prepushPassed !== true) return false;
  if (state.flakeAttempts >= CI_FLAKE_MAX_RETRIES) return false;
  if (state.fileCount <= 0) return false;
  return true;
}

/**
 * Backoff in ms for the given zero-based attempt index. Returns 0 when
 * index is out of range — callers should check the bound via
 * `shouldRetryCiFlake` before asking for the delay.
 */
export function ciFlakeBackoffMs(attemptIdx: number): number {
  if (attemptIdx < 0 || attemptIdx >= CI_FLAKE_BACKOFF_MS.length) return 0;
  return CI_FLAKE_BACKOFF_MS[attemptIdx];
}
