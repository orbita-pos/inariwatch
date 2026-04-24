import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

// runContainerAgent is the only downstream dep; we mock it per test.
const runContainerAgentMock = vi.fn();

vi.mock("@/lib/db", () => ({}));

vi.mock("../container-agent", () => ({
  runContainerAgent: (...args: unknown[]) => runContainerAgentMock(...args),
}));

import {
  runMultiAgentFanout,
  isFanoutEnabled,
  buildHypothesisErrorContext,
  MAX_SUB_AGENTS,
  FANOUT_TIMEOUT_MS,
  type CoordinatorInput,
  type SubAgentSpec,
} from "../multi-agent-coordinator";
import type { Hypothesis } from "../hypothesis-generator";

const sess = {
  id: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-000000000002",
  alertId: "00000000-0000-0000-0000-000000000003",
  userId: "00000000-0000-0000-0000-000000000004",
};

function hypothesis(id: string, conf = 50): Hypothesis {
  return {
    id,
    diagnosis: `diagnosis for ${id}`,
    reasoning: `reasoning for ${id}`,
    scopeGlob: null,
    confidence: conf,
  };
}

function spec(id: string): SubAgentSpec {
  return {
    hypothesis: hypothesis(id),
    containerId: `c-${id}`,
    containerUrl: "https://staging.test",
    stagingSecret: "secret",
  };
}

function baseInput(subAgents: SubAgentSpec[], emit = vi.fn()): CoordinatorInput {
  return {
    session: sess,
    apiKey: "test-key",
    provider: "openai",
    exploreModel: "gpt-5-mini",
    fixModel: "gpt-5.4",
    baseErrorContext: "The alert body and diagnosis.",
    subAgents,
    emit,
  };
}

beforeEach(() => {
  runContainerAgentMock.mockReset();
  process.env.MULTI_AGENT_FANOUT = "true";
});

afterEach(() => {
  delete process.env.MULTI_AGENT_FANOUT;
});

// ── isFanoutEnabled ────────────────────────────────────────────────────────

describe("isFanoutEnabled", () => {
  it("returns true only when MULTI_AGENT_FANOUT is 'true' or '1'", () => {
    process.env.MULTI_AGENT_FANOUT = "true";
    expect(isFanoutEnabled()).toBe(true);
    process.env.MULTI_AGENT_FANOUT = "1";
    expect(isFanoutEnabled()).toBe(true);
    process.env.MULTI_AGENT_FANOUT = "false";
    expect(isFanoutEnabled()).toBe(false);
    process.env.MULTI_AGENT_FANOUT = "yes";
    expect(isFanoutEnabled()).toBe(false);
    delete process.env.MULTI_AGENT_FANOUT;
    expect(isFanoutEnabled()).toBe(false);
  });
});

// ── buildHypothesisErrorContext ────────────────────────────────────────────

describe("buildHypothesisErrorContext", () => {
  it("prepends the hypothesis block with a visible separator", () => {
    const ctx = buildHypothesisErrorContext(hypothesis("h1"), "ORIGINAL_ERROR_CONTEXT");
    expect(ctx).toContain("FOCUSED HYPOTHESIS");
    expect(ctx).toContain("Hypothesis id: h1");
    expect(ctx).toContain("diagnosis for h1");
    expect(ctx).toContain("reasoning for h1");
    expect(ctx).toContain("ORIGINAL_ERROR_CONTEXT");
    expect(ctx.indexOf("FOCUSED HYPOTHESIS")).toBeLessThan(ctx.indexOf("ORIGINAL_ERROR_CONTEXT"));
  });

  it("mentions the scope hint when scopeGlob is set", () => {
    const h = { ...hypothesis("h1"), scopeGlob: "src/auth/**/*.ts" };
    const ctx = buildHypothesisErrorContext(h, "x");
    expect(ctx).toContain("src/auth/**/*.ts");
  });

  it("says repo-wide when scopeGlob is null", () => {
    const ctx = buildHypothesisErrorContext(hypothesis("h1"), "x");
    expect(ctx).toContain("repo-wide");
  });
});

// ── runMultiAgentFanout ────────────────────────────────────────────────────

describe("runMultiAgentFanout", () => {
  it("returns skipped=disabled when MULTI_AGENT_FANOUT is off", async () => {
    delete process.env.MULTI_AGENT_FANOUT;
    const r = await runMultiAgentFanout(baseInput([spec("a"), spec("b")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("disabled");
    expect(runContainerAgentMock).not.toHaveBeenCalled();
  });

  it("returns skipped=too_few_hypotheses with < 2 sub-agents", async () => {
    const r = await runMultiAgentFanout(baseInput([spec("a")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("too_few_hypotheses");
    expect(runContainerAgentMock).not.toHaveBeenCalled();
  });

  it("caps sub-agents to MAX_SUB_AGENTS", async () => {
    const hs = Array.from({ length: MAX_SUB_AGENTS + 2 }, (_, i) => spec(`h${i}`));
    runContainerAgentMock.mockResolvedValue({
      explanation: "fix", files: [{ path: "a.ts", content: "x" }],
      turns: 3, verified: true, testsPassed: true,
    });
    await runMultiAgentFanout(baseInput(hs));
    expect(runContainerAgentMock.mock.calls.length).toBe(MAX_SUB_AGENTS);
  });

  it("returns ok with the first verified winner", async () => {
    // Winner: 2nd sub-agent succeeds first (deterministic via mock order).
    runContainerAgentMock
      .mockImplementationOnce(async () => ({
        explanation: "win-a", files: [{ path: "a.ts", content: "a" }],
        turns: 4, verified: true, testsPassed: true,
      }))
      .mockImplementationOnce(async () => ({
        explanation: "win-b", files: [{ path: "b.ts", content: "b" }],
        turns: 5, verified: true, testsPassed: false,
      }));
    const emit = vi.fn();
    const r = await runMultiAgentFanout(baseInput([spec("a"), spec("b")], emit));
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Winner is whichever resolves first (a, since it's first in mock order).
      expect(["a", "b"]).toContain(r.winnerHypothesisId);
      expect(r.files.length).toBe(1);
      expect(r.losersCount).toBe(1);
    }
    // fanout_started + fanout_winner emitted
    const events = emit.mock.calls.map((c) => c[0]);
    expect(events).toContain("fanout_started");
    expect(events).toContain("fanout_winner");
  });

  it("treats unverified results as non-winners (falls through)", async () => {
    runContainerAgentMock.mockResolvedValue({
      explanation: "no", files: [], turns: 15, verified: false, testsPassed: false,
    });
    const r = await runMultiAgentFanout(baseInput([spec("a"), spec("b"), spec("c")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("all_sub_agents_failed");
  });

  it("returns skipped=all_sub_agents_failed when every sub-agent throws", async () => {
    runContainerAgentMock.mockRejectedValue(new Error("model down"));
    const r = await runMultiAgentFanout(baseInput([spec("a"), spec("b")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped).toBe("all_sub_agents_failed");
  });

  it("emits sub_agent_<event> for events re-emitted from each sub-agent", async () => {
    runContainerAgentMock.mockImplementation(async (params: {
      emit: (event: string, data: Record<string, unknown>) => void;
    }) => {
      params.emit("container_turn", { turn: 1 });
      return {
        explanation: "ok", files: [{ path: "a.ts", content: "x" }],
        turns: 1, verified: true, testsPassed: true,
      };
    });
    const emit = vi.fn();
    await runMultiAgentFanout(baseInput([spec("a"), spec("b")], emit));
    const subTurnEvents = emit.mock.calls.filter((c) => c[0] === "sub_agent_container_turn");
    expect(subTurnEvents.length).toBeGreaterThanOrEqual(1);
    for (const ev of subTurnEvents) {
      expect((ev[1] as { subAgentId: string }).subAgentId).toMatch(/^s\d+$/);
    }
  });

  it("FANOUT_TIMEOUT_MS is a sane safety ceiling", () => {
    expect(FANOUT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(FANOUT_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });
});
