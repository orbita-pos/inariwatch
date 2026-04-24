import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

const createContainerMock = vi.fn();
const destroyContainerMock = vi.fn();
const runMultiAgentFanoutMock = vi.fn();

vi.mock("@/lib/db", () => ({}));

vi.mock("../container-agent", () => ({
  createContainer: (...args: unknown[]) => createContainerMock(...args),
  destroyContainer: (...args: unknown[]) => destroyContainerMock(...args),
}));

vi.mock("../multi-agent-coordinator", () => ({
  runMultiAgentFanout: (...args: unknown[]) => runMultiAgentFanoutMock(...args),
  isFanoutEnabled: () => process.env.MULTI_AGENT_FANOUT === "true" || process.env.MULTI_AGENT_FANOUT === "1",
  MAX_SUB_AGENTS: 3,
}));

import { runTier2MultiAgent, type Tier2MultiAgentContext } from "../tier-2-handler";
import type { Hypothesis } from "../hypothesis-generator";

const sess = {
  id: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-000000000002",
  alertId: "00000000-0000-0000-0000-000000000003",
  userId: "00000000-0000-0000-0000-000000000004",
};

function hypothesis(id: string): Hypothesis {
  return {
    id, diagnosis: `d-${id}`, reasoning: `r-${id}`, scopeGlob: null, confidence: 50,
  };
}

function baseCtx(hypotheses: Hypothesis[]): Tier2MultiAgentContext {
  return {
    hypotheses,
    baseErrorContext: "alert + diagnosis",
    apiKey: "key",
    provider: "openai",
    exploreModel: "gpt-5-mini",
    fixModel: "gpt-5.4",
    stagingUrl: "https://staging.test",
    stagingSecret: "secret",
    githubToken: "ghp_abc",
    repoUrl: "https://github.com/owner/repo.git",
    branch: "main",
    emit: vi.fn(),
  };
}

beforeEach(() => {
  createContainerMock.mockReset();
  destroyContainerMock.mockReset().mockResolvedValue(undefined);
  runMultiAgentFanoutMock.mockReset();
  process.env.MULTI_AGENT_FANOUT = "true";
});

afterEach(() => {
  delete process.env.MULTI_AGENT_FANOUT;
  delete process.env.FANOUT_CANARY_PCT;
});

describe("canary helpers", () => {
  it("fanoutCanaryPct defaults to 100 when unset", async () => {
    delete process.env.FANOUT_CANARY_PCT;
    const { fanoutCanaryPct } = await import("../tier-2-handler");
    expect(fanoutCanaryPct()).toBe(100);
  });

  it("fanoutCanaryPct clamps to [0, 100]", async () => {
    const { fanoutCanaryPct } = await import("../tier-2-handler");
    process.env.FANOUT_CANARY_PCT = "-5";
    expect(fanoutCanaryPct()).toBe(0);
    process.env.FANOUT_CANARY_PCT = "999";
    expect(fanoutCanaryPct()).toBe(100);
    process.env.FANOUT_CANARY_PCT = "not a number";
    expect(fanoutCanaryPct()).toBe(100);
    process.env.FANOUT_CANARY_PCT = "20";
    expect(fanoutCanaryPct()).toBe(20);
  });

  it("sessionInCanary is deterministic for a given session id", async () => {
    const { sessionInCanary } = await import("../tier-2-handler");
    const id = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
    const a = sessionInCanary(id, 50);
    const b = sessionInCanary(id, 50);
    expect(a).toBe(b);
  });

  it("sessionInCanary: pct=0 rejects everything, pct=100 accepts everything", async () => {
    const { sessionInCanary } = await import("../tier-2-handler");
    for (let i = 0; i < 10; i++) {
      const id = `${i.toString().padStart(8, "0")}-0000-0000-0000-000000000000`;
      expect(sessionInCanary(id, 0)).toBe(false);
      expect(sessionInCanary(id, 100)).toBe(true);
    }
  });

  it("sessionInCanary: pct=20 accepts ~20% of random session ids", async () => {
    const { sessionInCanary } = await import("../tier-2-handler");
    let accepted = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      // Random-but-deterministic IDs — use the iteration number mixed
      // with a salt so the bucket distribution is roughly uniform.
      const id = `${i.toString(16).padStart(8, "0")}-aaaa-bbbb-cccc-${i.toString(16).padStart(12, "0")}`;
      if (sessionInCanary(id, 20)) accepted++;
    }
    // 20% ± 3% tolerance on N=2000 samples.
    expect(accepted / N).toBeGreaterThan(0.17);
    expect(accepted / N).toBeLessThan(0.23);
  });
});

describe("runTier2MultiAgent", () => {
  it("returns skipped=disabled when MULTI_AGENT_FANOUT is off", async () => {
    delete process.env.MULTI_AGENT_FANOUT;
    const r = await runTier2MultiAgent(sess, baseCtx([hypothesis("a"), hypothesis("b")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("disabled");
    expect(createContainerMock).not.toHaveBeenCalled();
  });

  it("returns skipped=too_few_hypotheses when fewer than 2 hypotheses", async () => {
    const r = await runTier2MultiAgent(sess, baseCtx([hypothesis("a")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("too_few_hypotheses");
    expect(createContainerMock).not.toHaveBeenCalled();
  });

  it("returns skipped=canary_skip when session falls outside canary bucket (FANOUT_CANARY_PCT=0)", async () => {
    process.env.FANOUT_CANARY_PCT = "0";
    const r = await runTier2MultiAgent(sess, baseCtx([hypothesis("a"), hypothesis("b")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("canary_skip");
    expect(createContainerMock).not.toHaveBeenCalled();
  });

  it("FANOUT_CANARY_PCT=100 (default) lets every session through", async () => {
    createContainerMock.mockResolvedValue("c-x");
    runMultiAgentFanoutMock.mockResolvedValue({
      ok: true,
      winnerSubAgentId: "s0",
      winnerHypothesisId: "a",
      explanation: "fix",
      files: [{ path: "x.ts", content: "y" }],
      turns: 4,
      verified: true,
      testsPassed: true,
      durationMs: 1000,
      losersCount: 1,
    });
    const r = await runTier2MultiAgent(sess, baseCtx([hypothesis("a"), hypothesis("b")]));
    expect(r.ok).toBe(true);
  });

  it("returns skipped=no_staging_server when stagingUrl is empty", async () => {
    const ctx = baseCtx([hypothesis("a"), hypothesis("b")]);
    ctx.stagingUrl = "";
    const r = await runTier2MultiAgent(sess, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("no_staging_server");
  });

  it("creates N containers + destroys all N on success", async () => {
    createContainerMock.mockImplementation(async (_url, _secret, _repo, _branch, _token, sessionId) => `c-${sessionId}`);
    runMultiAgentFanoutMock.mockResolvedValue({
      ok: true,
      winnerSubAgentId: "s0",
      winnerHypothesisId: "a",
      explanation: "fix",
      files: [{ path: "x.ts", content: "y" }],
      turns: 4,
      verified: true,
      testsPassed: true,
      durationMs: 12_000,
      losersCount: 1,
    });

    const r = await runTier2MultiAgent(sess, baseCtx([hypothesis("a"), hypothesis("b")]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.winnerHypothesisId).toBe("a");
      expect(r.fileChanges).toEqual([{ path: "x.ts", content: "y" }]);
      expect(r.subAgentsRun).toBe(2);
    }
    expect(createContainerMock).toHaveBeenCalledTimes(2);
    expect(destroyContainerMock).toHaveBeenCalledTimes(2);
  });

  it("destroys partial containers on createContainer failure", async () => {
    createContainerMock
      .mockResolvedValueOnce("c-0")
      .mockRejectedValueOnce(new Error("pool full"));

    const r = await runTier2MultiAgent(sess, baseCtx([hypothesis("a"), hypothesis("b")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("container_create_failed");
    // The one that succeeded must be destroyed.
    expect(destroyContainerMock).toHaveBeenCalledTimes(1);
    expect(destroyContainerMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "c-0",
    );
    expect(runMultiAgentFanoutMock).not.toHaveBeenCalled();
  });

  it("maps coordinator skipped reasons onto handler skipped shape", async () => {
    createContainerMock.mockResolvedValue("c-x");
    runMultiAgentFanoutMock.mockResolvedValue({
      ok: false, skipped: "timeout", attempted: 2, durationMs: 120_000,
    });

    const r = await runTier2MultiAgent(sess, baseCtx([hypothesis("a"), hypothesis("b")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("timeout");
    expect(destroyContainerMock).toHaveBeenCalledTimes(2);
  });

  it("destroys containers even when coordinator returns all_sub_agents_failed", async () => {
    createContainerMock.mockResolvedValue("c-x");
    runMultiAgentFanoutMock.mockResolvedValue({
      ok: false, skipped: "all_sub_agents_failed", attempted: 3, durationMs: 40_000,
    });

    const r = await runTier2MultiAgent(sess, baseCtx([hypothesis("a"), hypothesis("b"), hypothesis("c")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("all_sub_agents_failed");
    expect(destroyContainerMock).toHaveBeenCalledTimes(3);
  });
});
