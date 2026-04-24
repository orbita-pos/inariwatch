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

  it("provisions containers in parallel (wall time ≈ max RTT, not sum)", async () => {
    // Each createContainer takes 50ms. Sequential (3 calls) = 150ms,
    // parallel = ~50ms. We allow 100ms of slack for vitest scheduling
    // jitter on slow CI; still far below the 150ms sequential bound.
    createContainerMock.mockImplementation(async (_url, _secret, _repo, _branch, _token, sessionId) => {
      await new Promise((r) => setTimeout(r, 50));
      return `c-${sessionId}`;
    });
    runMultiAgentFanoutMock.mockResolvedValue({
      ok: true,
      winnerSubAgentId: "s0", winnerHypothesisId: "a",
      explanation: "fix", files: [{ path: "x.ts", content: "y" }],
      turns: 1, verified: true, testsPassed: true,
      durationMs: 1, losersCount: 0,
    });

    const start = Date.now();
    const r = await runTier2MultiAgent(
      sess,
      baseCtx([hypothesis("a"), hypothesis("b"), hypothesis("c")])
    );
    const elapsed = Date.now() - start;

    expect(r.ok).toBe(true);
    expect(createContainerMock).toHaveBeenCalledTimes(3);
    // Parallel: elapsed should be roughly max(50ms) + coord overhead,
    // not sum(150ms). 120ms is a comfortable upper bound.
    expect(elapsed).toBeLessThan(120);
  });

  it("destroys every successful checkout when any parallel call fails", async () => {
    // Two succeed fast, one rejects — we must destroy the two that
    // landed, even though they arrived after the rejection.
    createContainerMock.mockImplementation(async (_url, _secret, _repo, _branch, _token, sessionId) => {
      const idx = sessionId.endsWith("-s0") ? 0 : sessionId.endsWith("-s1") ? 1 : 2;
      if (idx === 1) throw new Error("pool full on s1");
      await new Promise((r) => setTimeout(r, 10));
      return `c-${sessionId}`;
    });

    const r = await runTier2MultiAgent(
      sess,
      baseCtx([hypothesis("a"), hypothesis("b"), hypothesis("c")])
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("container_create_failed");
    // Two containers succeeded, both destroyed. The rejected one was
    // never created, so nothing to destroy for it.
    expect(destroyContainerMock).toHaveBeenCalledTimes(2);
    expect(runMultiAgentFanoutMock).not.toHaveBeenCalled();
  });
});
