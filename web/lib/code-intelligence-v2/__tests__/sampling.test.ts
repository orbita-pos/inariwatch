/**
 * Phase 3.1 — sampling controls.
 *
 * Covers:
 *   - kill switch (env-only, returns false unconditionally)
 *   - global SHADOW_SAMPLE_RATE env (typo / out-of-range protection)
 *   - per-workspace pct override (NULL passthrough; 0 / 100 boundaries)
 *   - dice-roll distribution (rate=0.5 over 1000 trials lands in [0.4, 0.6])
 *   - v2 timeout budget math
 *
 * The DB lookup is exercised via the `deps` injection seam — no real
 * Drizzle, no real Neon. The harness wiring is tested separately in
 * service-shadow-controls.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sampling.ts imports `db` from "@/lib/db", which throws "DATABASE_URL is
// not set" at module load when there's no env. Stub the module so the
// import resolves without touching Neon. Every test in this file uses
// the `deps` injection seam, so the real db is never called.
vi.mock("@/lib/db", () => ({
  db: {},
  organizations: {},
  projects: {},
}));

const ENV_KEYS = [
  "SHADOW_SAMPLE_RATE",
  "CODE_INTEL_V2_KILL_SHADOW",
  "CODE_INTEL_V2_MIN_V2_BUDGET_MS",
] as const;

const SAVED: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) SAVED[k] = process.env[k];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
}

beforeEach(clearEnv);
afterEach(restoreEnv);

import {
  DEFAULT_MIN_V2_BUDGET_MS,
  DEFAULT_SHADOW_SAMPLE_RATE,
  isShadowKilled,
  resolveGlobalShadowRate,
  resolveMinV2BudgetMs,
  shouldShadowSample,
  v2AdditionalBudgetMs,
} from "../sampling";

// ── isShadowKilled ─────────────────────────────────────────────────────────

describe("isShadowKilled", () => {
  it("default off when env unset", () => {
    expect(isShadowKilled()).toBe(false);
  });

  it("accepts the standard truthy spellings", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "  on  "]) {
      process.env.CODE_INTEL_V2_KILL_SHADOW = v;
      expect(isShadowKilled()).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const v of ["0", "false", "off", "no", "", "shadow"]) {
      process.env.CODE_INTEL_V2_KILL_SHADOW = v;
      expect(isShadowKilled()).toBe(false);
    }
  });
});

// ── resolveGlobalShadowRate ────────────────────────────────────────────────

describe("resolveGlobalShadowRate", () => {
  it("defaults to 1.0 when env unset", () => {
    expect(resolveGlobalShadowRate()).toBe(DEFAULT_SHADOW_SAMPLE_RATE);
    expect(DEFAULT_SHADOW_SAMPLE_RATE).toBe(1.0);
  });

  it("returns the env value as-is when in [0, 1]", () => {
    process.env.SHADOW_SAMPLE_RATE = "0";
    expect(resolveGlobalShadowRate()).toBe(0);
    process.env.SHADOW_SAMPLE_RATE = "0.5";
    expect(resolveGlobalShadowRate()).toBe(0.5);
    process.env.SHADOW_SAMPLE_RATE = "1";
    expect(resolveGlobalShadowRate()).toBe(1);
  });

  it("clamps out-of-range values", () => {
    process.env.SHADOW_SAMPLE_RATE = "-0.5";
    expect(resolveGlobalShadowRate()).toBe(0);
    process.env.SHADOW_SAMPLE_RATE = "5";
    expect(resolveGlobalShadowRate()).toBe(1);
  });

  it("falls back to default for non-numeric values (typo protection)", () => {
    process.env.SHADOW_SAMPLE_RATE = "fifty percent";
    expect(resolveGlobalShadowRate()).toBe(DEFAULT_SHADOW_SAMPLE_RATE);
    process.env.SHADOW_SAMPLE_RATE = "50%";
    expect(resolveGlobalShadowRate()).toBe(DEFAULT_SHADOW_SAMPLE_RATE);
  });
});

// ── resolveMinV2BudgetMs ───────────────────────────────────────────────────

describe("resolveMinV2BudgetMs", () => {
  it("defaults to DEFAULT_MIN_V2_BUDGET_MS", () => {
    expect(resolveMinV2BudgetMs()).toBe(DEFAULT_MIN_V2_BUDGET_MS);
    expect(DEFAULT_MIN_V2_BUDGET_MS).toBe(100);
  });

  it("respects a positive integer override", () => {
    process.env.CODE_INTEL_V2_MIN_V2_BUDGET_MS = "25";
    expect(resolveMinV2BudgetMs()).toBe(25);
  });

  it("falls back to default for non-numeric or negative", () => {
    process.env.CODE_INTEL_V2_MIN_V2_BUDGET_MS = "abc";
    expect(resolveMinV2BudgetMs()).toBe(DEFAULT_MIN_V2_BUDGET_MS);
    process.env.CODE_INTEL_V2_MIN_V2_BUDGET_MS = "-50";
    expect(resolveMinV2BudgetMs()).toBe(DEFAULT_MIN_V2_BUDGET_MS);
  });
});

// ── shouldShadowSample ─────────────────────────────────────────────────────

const stubDeps = (pct: number | null, fixedRandom = 0) => ({
  getWorkspaceShadowPct: async () => pct,
  random: () => fixedRandom,
});

describe("shouldShadowSample", () => {
  it("returns false when kill switch is set, regardless of pct/rate", async () => {
    process.env.CODE_INTEL_V2_KILL_SHADOW = "1";
    process.env.SHADOW_SAMPLE_RATE = "1";
    expect(await shouldShadowSample("p1", stubDeps(100, 0))).toBe(false);
    expect(await shouldShadowSample("p1", stubDeps(null, 0))).toBe(false);
  });

  it("uses workspace pct when present (overrides env)", async () => {
    process.env.SHADOW_SAMPLE_RATE = "1"; // env says always
    // workspace says never
    expect(await shouldShadowSample("p1", stubDeps(0, 0))).toBe(false);
    // workspace says always
    expect(await shouldShadowSample("p1", stubDeps(100, 0.99))).toBe(true);
  });

  it("falls back to global rate when workspace pct is null", async () => {
    process.env.SHADOW_SAMPLE_RATE = "0";
    expect(await shouldShadowSample("p1", stubDeps(null, 0))).toBe(false);
    process.env.SHADOW_SAMPLE_RATE = "1";
    expect(await shouldShadowSample("p1", stubDeps(null, 0.99))).toBe(true);
  });

  it("rolls the dice when 0 < rate < 1 (deterministic via stub random)", async () => {
    // workspace pct = 50 → rate = 0.5
    // random < 0.5 → sample
    expect(await shouldShadowSample("p1", stubDeps(50, 0.49))).toBe(true);
    // random >= 0.5 → skip
    expect(await shouldShadowSample("p1", stubDeps(50, 0.5))).toBe(false);
    expect(await shouldShadowSample("p1", stubDeps(50, 0.99))).toBe(false);
  });

  it("treats DB lookup errors as 'no override' (falls back to env rate)", async () => {
    process.env.SHADOW_SAMPLE_RATE = "1";
    const failingDeps = {
      getWorkspaceShadowPct: async () => {
        throw new Error("Neon hiccup");
      },
      random: () => 0,
    };
    expect(await shouldShadowSample("p1", failingDeps)).toBe(true);
  });

  it("distribution: rate=0.5 over 1000 trials lands in [0.4, 0.6]", async () => {
    process.env.SHADOW_SAMPLE_RATE = "0.5";
    // Linear-congruential PRNG seeded so the test is deterministic but
    // exercises a different `random()` value on every call. Math.random
    // would also work but might flake — this guarantees [0.4, 0.6].
    let s = 0xdeadbeef;
    const rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
    let hits = 0;
    for (let i = 0; i < 1000; i++) {
      if (await shouldShadowSample("p1", stubDeps(null, rng()))) hits++;
    }
    expect(hits / 1000).toBeGreaterThanOrEqual(0.4);
    expect(hits / 1000).toBeLessThanOrEqual(0.6);
  });
});

// ── v2AdditionalBudgetMs ───────────────────────────────────────────────────

describe("v2AdditionalBudgetMs", () => {
  it("returns max(v1Ms, MIN_V2_BUDGET_MS)", () => {
    process.env.CODE_INTEL_V2_MIN_V2_BUDGET_MS = "50";
    // v1 was very fast — floor kicks in
    expect(v2AdditionalBudgetMs(5)).toBe(50);
    // v1 was slower than the floor — ratio rule kicks in
    expect(v2AdditionalBudgetMs(200)).toBe(200);
    // v1 was exactly the floor — either is fine; we return the larger
    expect(v2AdditionalBudgetMs(50)).toBe(50);
  });
});
