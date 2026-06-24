/**
 * Fase 4 Part C — CI flake retry policy tests.
 *
 * Covers every gate independently so the decision matrix is explicit in
 * the test file. Adversarial cases: we MUST NOT retry when prepush didn't
 * run (null), MUST NOT retry when either flag is off, MUST NOT retry
 * beyond the 3-attempt cap, MUST NOT retry with zero files (defensive).
 */

import { describe, it, expect } from "vitest";
import {
  shouldRetryCiFlake,
  ciFlakeBackoffMs,
  CI_FLAKE_BACKOFF_MS,
  CI_FLAKE_MAX_RETRIES,
  type CiRetryState,
} from "../ci-retry";

function baseState(overrides: Partial<CiRetryState> = {}): CiRetryState {
  return {
    ciStatus: "failure",
    prepushEnabled: true,
    ciWebhookEnabled: true,
    prepushPassed: true,
    flakeAttempts: 0,
    fileCount: 3,
    ...overrides,
  };
}

describe("shouldRetryCiFlake — happy path", () => {
  it("returns true when all gates are green", () => {
    expect(shouldRetryCiFlake(baseState())).toBe(true);
  });

  it("returns true through retry 0, 1, 2 (inclusive) and false at 3", () => {
    expect(shouldRetryCiFlake(baseState({ flakeAttempts: 0 }))).toBe(true);
    expect(shouldRetryCiFlake(baseState({ flakeAttempts: 1 }))).toBe(true);
    expect(shouldRetryCiFlake(baseState({ flakeAttempts: 2 }))).toBe(true);
    expect(shouldRetryCiFlake(baseState({ flakeAttempts: 3 }))).toBe(false);
    expect(shouldRetryCiFlake(baseState({ flakeAttempts: 4 }))).toBe(false);
  });
});

describe("shouldRetryCiFlake — gate: ciStatus", () => {
  it("false when CI succeeded (nothing to retry)", () => {
    expect(shouldRetryCiFlake(baseState({ ciStatus: "success" }))).toBe(false);
  });

  it("false when CI is still pending (not decided)", () => {
    expect(shouldRetryCiFlake(baseState({ ciStatus: "pending" }))).toBe(false);
  });

  it("false when CI is in_progress", () => {
    expect(shouldRetryCiFlake(baseState({ ciStatus: "in_progress" }))).toBe(false);
  });
});

describe("shouldRetryCiFlake — gate: flags", () => {
  it("false when PREPUSH_TESTS_ENABLED is off", () => {
    expect(shouldRetryCiFlake(baseState({ prepushEnabled: false }))).toBe(false);
  });

  it("false when CI_WEBHOOK_MODE is off", () => {
    expect(shouldRetryCiFlake(baseState({ ciWebhookEnabled: false }))).toBe(false);
  });

  it("false when BOTH flags off", () => {
    expect(shouldRetryCiFlake(baseState({ prepushEnabled: false, ciWebhookEnabled: false }))).toBe(false);
  });
});

describe("shouldRetryCiFlake — gate: prepush signal", () => {
  it("false when prepushPassed is null (didn't run — old worker or Vercel fallback)", () => {
    expect(shouldRetryCiFlake(baseState({ prepushPassed: null }))).toBe(false);
  });

  it("false when prepushPassed is false (ran but failed — unreachable in practice)", () => {
    expect(shouldRetryCiFlake(baseState({ prepushPassed: false }))).toBe(false);
  });
});

describe("shouldRetryCiFlake — gate: file count", () => {
  it("false when fileCount is 0 (defensive — nothing to re-push)", () => {
    expect(shouldRetryCiFlake(baseState({ fileCount: 0 }))).toBe(false);
  });

  it("true when fileCount is 1 (minimal valid re-push)", () => {
    expect(shouldRetryCiFlake(baseState({ fileCount: 1 }))).toBe(true);
  });
});

// ── ciFlakeBackoffMs ─────────────────────────────────────────────────────

describe("ciFlakeBackoffMs", () => {
  it("returns the documented 30s / 2m / 5m schedule", () => {
    expect(ciFlakeBackoffMs(0)).toBe(30_000);
    expect(ciFlakeBackoffMs(1)).toBe(120_000);
    expect(ciFlakeBackoffMs(2)).toBe(300_000);
  });

  it("returns 0 for out-of-range indices (defensive)", () => {
    expect(ciFlakeBackoffMs(-1)).toBe(0);
    expect(ciFlakeBackoffMs(3)).toBe(0);
    expect(ciFlakeBackoffMs(99)).toBe(0);
  });

  it("schedule matches the exported constants exactly", () => {
    expect(CI_FLAKE_BACKOFF_MS.length).toBe(CI_FLAKE_MAX_RETRIES);
    expect(CI_FLAKE_BACKOFF_MS[0]).toBe(30_000);
    expect(CI_FLAKE_BACKOFF_MS[1]).toBe(120_000);
    expect(CI_FLAKE_BACKOFF_MS[2]).toBe(300_000);
  });
});
