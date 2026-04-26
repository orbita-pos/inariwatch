/**
 * Sesión 18 — Substrate v2 in-loop gate canary.
 *
 * Verifies the wedge contract:
 *   1. SUBSTRATE_V2_GATE unset → byte-identical to v1-only (no v2 call,
 *      no DB write, verdict comes straight from v1).
 *   2. Flag on but alert NOT in canary bucket → still v1-only, no DB write.
 *   3. Flag on AND in canary → v1 + v2 run in parallel, comparison row
 *      persisted, verdict = v2 when v2 produced one.
 *   4. v2 returns null (no recording / 503 / network) → fall back to v1
 *      and still log the comparison row (so the dashboard can attribute
 *      the null to a runner_mode).
 *
 * Determinism note: `inSubstrateV2Canary` hashes the alertId, so we pick
 * UUIDs known to fall inside / outside the 5% bucket and assert that.
 * If the hashing changes the canary UUIDs need to be re-picked — the
 * `selects bucket boundaries` test will flag that immediately.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const insertValuesReturningMock = vi.fn();
const insertValuesMock = vi.fn(() => ({ returning: insertValuesReturningMock }));
const insertCallCount = { n: 0 };

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => {
      insertCallCount.n += 1;
      return { values: insertValuesMock };
    },
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
        }),
      }),
    }),
  },
  substrateRecordings: Symbol("substrateRecordings"),
  substrateReplayComparisons: Symbol("substrateReplayComparisons"),
}));

vi.mock("@/lib/db/schema", () => ({
  replaySessions: Symbol("replaySessions"),
}));

vi.mock("../client", () => ({
  callAI: vi.fn(),
}));

import {
  runReplayGate,
  inSubstrateV2Canary,
  type ReplayResult,
} from "../substrate-replay";

const ALERT_IN_BUCKET = (() => {
  // Find a UUID-shaped string that falls in the 5% canary bucket. We pick
  // small integers cast to UUID format; whichever is the first to land in
  // the bucket is recorded as the constant (deterministic across runs).
  for (let i = 0; i < 5000; i++) {
    const id = `00000000-0000-0000-0000-${i.toString().padStart(12, "0")}`;
    if (inSubstrateV2Canary(id)) return id;
  }
  throw new Error("no canary UUID found in first 5000 — hashing broken?");
})();

const ALERT_OUT_BUCKET = (() => {
  for (let i = 0; i < 5000; i++) {
    const id = `11111111-1111-1111-1111-${i.toString().padStart(12, "0")}`;
    if (!inSubstrateV2Canary(id)) return id;
  }
  throw new Error("no non-canary UUID found in first 5000");
})();

const v1Pass: ReplayResult = {
  passed: true,
  confidence: 80,
  riskScore: 20,
  analysis: "v1 says fix prevents the recorded crash",
  replayedEvents: 12,
  mode: "ai_analysis",
};

const v1Fail: ReplayResult = {
  passed: false,
  confidence: 70,
  riskScore: 75,
  analysis: "v1 says the fix misses the failing path",
  replayedEvents: 8,
  mode: "ai_analysis",
};

const v2Pass = {
  result: {
    passed: true,
    confidence: 95,
    riskScore: 10,
    analysis: "v2 deterministic drain — throw not reproduced",
    replayedEvents: 50,
    mode: "raas_v2" as const,
    v2RunnerMode: "live",
  },
  runnerMode: "live",
};

const baseArgs = {
  projectId: "proj-1",
  alertId: ALERT_IN_BUCKET,
  diagnosis: "diagnosis text",
  fixFiles: [{ path: "src/x.ts", content: "fix" }],
  apiKey: "k",
  provider: "openai" as const,
  model: "gpt-4o-mini",
  log: { userId: "user-1" },
};

beforeEach(() => {
  insertCallCount.n = 0;
  insertValuesMock.mockClear();
  insertValuesReturningMock.mockReset().mockResolvedValue([{ id: "comp-1" }]);
  delete process.env.SUBSTRATE_V2_GATE;
});

describe("Sesión 18 — runReplayGate canary", () => {
  it("byte-identical when SUBSTRATE_V2_GATE is unset (no v2 call, no DB write)", async () => {
    const v1Impl = vi.fn().mockResolvedValue(v1Pass);
    const v2Impl = vi.fn();

    const out = await runReplayGate({ ...baseArgs, v1Impl, v2Impl });

    expect(v1Impl).toHaveBeenCalledTimes(1);
    expect(v2Impl).not.toHaveBeenCalled();
    expect(insertCallCount.n).toBe(0);
    expect(out).toEqual({
      verdict: v1Pass,
      source: "v1",
      canaryFired: false,
      comparisonId: null,
      v2RunnerMode: null,
    });
  });

  it("flag on but alert outside canary bucket → still v1-only, no DB write", async () => {
    process.env.SUBSTRATE_V2_GATE = "true";
    const v1Impl = vi.fn().mockResolvedValue(v1Pass);
    const v2Impl = vi.fn();

    const out = await runReplayGate({
      ...baseArgs,
      alertId: ALERT_OUT_BUCKET,
      v1Impl,
      v2Impl,
    });

    expect(v1Impl).toHaveBeenCalledTimes(1);
    expect(v2Impl).not.toHaveBeenCalled();
    expect(insertCallCount.n).toBe(0);
    expect(out.canaryFired).toBe(false);
    expect(out.source).toBe("v1");
  });

  it("flag on + in canary → both run, v2 verdict wins, comparison persisted", async () => {
    process.env.SUBSTRATE_V2_GATE = "true";
    const v1Impl = vi.fn().mockResolvedValue(v1Fail); // intentionally disagrees
    const v2Impl = vi.fn().mockResolvedValue(v2Pass);

    const out = await runReplayGate({ ...baseArgs, v1Impl, v2Impl });

    expect(v1Impl).toHaveBeenCalledTimes(1);
    expect(v2Impl).toHaveBeenCalledTimes(1);
    expect(out.canaryFired).toBe(true);
    expect(out.source).toBe("v2");
    expect(out.verdict?.passed).toBe(true); // v2 said pass
    expect(out.v2RunnerMode).toBe("live");

    // Comparison row was inserted with disagreement flagged.
    expect(insertCallCount.n).toBe(1);
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const calls = insertValuesMock.mock.calls as unknown as unknown[][];
    const row = (calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(row.alertId).toBe(ALERT_IN_BUCKET);
    expect(row.v1Passed).toBe(false);
    expect(row.v2Passed).toBe(true);
    expect(row.agreed).toBe(false);
    expect(row.chosen).toBe("v2");
    expect(row.v2RunnerMode).toBe("live");
    expect(out.comparisonId).toBe("comp-1");
  });

  it("v2 returns null → fall back to v1, comparison still logged with runner_mode", async () => {
    process.env.SUBSTRATE_V2_GATE = "true";
    const v1Impl = vi.fn().mockResolvedValue(v1Pass);
    const v2Impl = vi.fn().mockResolvedValue({ result: null, runnerMode: "no_recording" });

    const out = await runReplayGate({ ...baseArgs, v1Impl, v2Impl });

    expect(out.canaryFired).toBe(true);
    expect(out.source).toBe("v1");
    expect(out.verdict).toBe(v1Pass);
    expect(out.v2RunnerMode).toBe("no_recording");
    expect(insertCallCount.n).toBe(1);
    const calls = insertValuesMock.mock.calls as unknown as unknown[][];
    const row = (calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(row.v2Passed).toBeNull();
    expect(row.v1Passed).toBe(true);
    expect(row.agreed).toBeNull(); // can't agree when one side is null
    expect(row.chosen).toBe("v1");
  });

  it("forceCanary=true bypasses bucket math (used by manual replay button)", async () => {
    process.env.SUBSTRATE_V2_GATE = "true";
    const v1Impl = vi.fn().mockResolvedValue(v1Pass);
    const v2Impl = vi.fn().mockResolvedValue(v2Pass);

    const out = await runReplayGate({
      ...baseArgs,
      alertId: ALERT_OUT_BUCKET, // would normally skip
      forceCanary: true,
      v1Impl,
      v2Impl,
    });
    expect(out.canaryFired).toBe(true);
    expect(out.source).toBe("v2");
    expect(insertCallCount.n).toBe(1);
  });

  it("comparison insert failure is swallowed — gate never blocks on telemetry", async () => {
    process.env.SUBSTRATE_V2_GATE = "true";
    insertValuesReturningMock.mockRejectedValueOnce(new Error("db down"));
    const v1Impl = vi.fn().mockResolvedValue(v1Pass);
    const v2Impl = vi.fn().mockResolvedValue(v2Pass);

    const out = await runReplayGate({ ...baseArgs, v1Impl, v2Impl });
    expect(out.verdict?.passed).toBe(true);
    expect(out.source).toBe("v2");
    expect(out.comparisonId).toBeNull();
  });
});

describe("inSubstrateV2Canary — bucket math", () => {
  it("0% returns false for everyone", () => {
    expect(inSubstrateV2Canary(ALERT_IN_BUCKET, 0)).toBe(false);
  });

  it("100% returns true for everyone", () => {
    expect(inSubstrateV2Canary(ALERT_OUT_BUCKET, 100)).toBe(true);
  });

  it("identical alertIds always pick the same bucket", () => {
    const id = "abcdef00-0000-0000-0000-000000000001";
    const a = inSubstrateV2Canary(id, 5);
    const b = inSubstrateV2Canary(id, 5);
    expect(a).toBe(b);
  });

  it("5% bucket is approximately 5% over a wide sample", () => {
    let count = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const id = `dddddddd-dddd-dddd-dddd-${i.toString().padStart(12, "0")}`;
      if (inSubstrateV2Canary(id, 5)) count++;
    }
    const ratio = count / N;
    // Generous tolerance — sha256 over sequential ids is uniform but this
    // is a CI-friendly bound, not a statistical proof.
    expect(ratio).toBeGreaterThan(0.025);
    expect(ratio).toBeLessThan(0.085);
  });
});
