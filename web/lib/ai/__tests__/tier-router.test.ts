import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

const executeMock = vi.fn();
const updateWhereMock = vi.fn().mockResolvedValue(undefined);
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));
const insertValuesMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => ({
  db: {
    execute: (...args: unknown[]) => executeMock(...args),
    update: () => ({ set: updateSetMock }),
    insert: () => ({ values: insertValuesMock }),
  },
  remediationSessions: { id: "id" },
  aiUsageLogs: Symbol("aiUsageLogs"),
}));

const callAIMock = vi.fn();
vi.mock("../client", () => ({
  callAI: (...args: unknown[]) => callAIMock(...args),
}));

const lookupPatternMock = vi.fn();
vi.mock("../pattern-memory", () => ({
  lookupPattern: (...args: unknown[]) => lookupPatternMock(...args),
}));

// Import AFTER mocks
import {
  getTierRouterMode,
  parseClassifierResponse,
  heuristicClassify,
  extractRouterFeatures,
  classifyTier,
  routeTier,
  meetsTier0PromotionGate,
  __resetTierRouterCircuit,
  type RouterFeatures,
} from "../tier-router";
import type { PatternMatch } from "../pattern-memory";

const rowsResult = <T>(rows: T[]) => Object.assign([...rows], { rows });
const uuidMap = new Map<string, string>();
const uuid = (label: string) => {
  let v = uuidMap.get(label);
  if (v) return v;
  const hex = (uuidMap.size + 1).toString(16).padStart(8, "0");
  v = `${hex}-0000-0000-0000-000000000000`;
  uuidMap.set(label, v);
  return v;
};

const baseFeatures: RouterFeatures = {
  errorCategory: "TypeError",
  severity: "medium",
  stackDepth: 5,
  stackTopFrameUserCode: true,
  affectedFileCount: 1,
  patternMatchScore: 0,
  patternMatchSuccessCount: 0,
  patternMatchHealth: 0,
  hasSubstrateRecording: false,
  hasCaptureBreadcrumbs: false,
  hasGitContext: false,
  priorRemediationsForFingerprint: 0,
};

beforeEach(() => {
  executeMock.mockReset();
  updateWhereMock.mockReset().mockResolvedValue(undefined);
  updateSetMock.mockReset().mockImplementation(() => ({ where: updateWhereMock }));
  updateMock.mockReset().mockImplementation(() => ({ set: updateSetMock }));
  insertValuesMock.mockReset().mockResolvedValue(undefined);
  callAIMock.mockReset();
  lookupPatternMock.mockReset().mockResolvedValue([]);
  __resetTierRouterCircuit();
  delete process.env.TIER_ROUTER_MODE;
  process.env.PLATFORM_AI_KEY = "test-key";
});

afterEach(() => {
  delete process.env.PLATFORM_AI_KEY;
});

// ── getTierRouterMode ───────────────────────────────────────────────────────

describe("getTierRouterMode", () => {
  it("defaults to 'off' when env unset", () => {
    expect(getTierRouterMode()).toBe("off");
  });
  it("parses 'shadow'", () => {
    process.env.TIER_ROUTER_MODE = "shadow";
    expect(getTierRouterMode()).toBe("shadow");
  });
  it("parses 'live'", () => {
    process.env.TIER_ROUTER_MODE = "live";
    expect(getTierRouterMode()).toBe("live");
  });
  it("treats unknown values as 'off'", () => {
    process.env.TIER_ROUTER_MODE = "enabled";
    expect(getTierRouterMode()).toBe("off");
  });
});

// ── parseClassifierResponse ─────────────────────────────────────────────────

describe("parseClassifierResponse", () => {
  it("parses valid JSON", () => {
    const r = parseClassifierResponse('{"tier":1,"reason":"simple","confidence":0.8}');
    expect(r).toEqual({ tier: 1, reason: "simple", confidence: 0.8 });
  });

  it("strips markdown fences", () => {
    const r = parseClassifierResponse('```json\n{"tier":2,"reason":"default","confidence":0.9}\n```');
    expect(r?.tier).toBe(2);
  });

  it("rejects invalid tier value", () => {
    expect(parseClassifierResponse('{"tier":5,"reason":"x","confidence":0.8}')).toBeNull();
  });

  it("rejects non-string reason", () => {
    expect(parseClassifierResponse('{"tier":2,"reason":42,"confidence":0.8}')).toBeNull();
  });

  it("rejects empty reason string", () => {
    expect(parseClassifierResponse('{"tier":2,"reason":"","confidence":0.8}')).toBeNull();
  });

  it("rejects non-finite confidence", () => {
    expect(parseClassifierResponse('{"tier":2,"reason":"x","confidence":null}')).toBeNull();
  });

  it("clamps confidence out of range", () => {
    const r = parseClassifierResponse('{"tier":1,"reason":"x","confidence":2.5}');
    expect(r?.confidence).toBe(1);
  });

  it("truncates overlong reason", () => {
    const long = "a".repeat(400);
    const r = parseClassifierResponse(`{"tier":2,"reason":"${long}","confidence":0.8}`);
    expect(r?.reason.length).toBe(200);
  });

  it("rejects malformed JSON", () => {
    expect(parseClassifierResponse("not json at all")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseClassifierResponse("")).toBeNull();
  });
});

// ── heuristicClassify ───────────────────────────────────────────────────────

describe("heuristicClassify", () => {
  it("picks Tier 0 on strong pattern + proven track record", () => {
    const r = heuristicClassify({
      ...baseFeatures,
      patternMatchScore: 0.95,
      patternMatchSuccessCount: 5,
      patternMatchHealth: 0.97,
    });
    expect(r.tier).toBe(0);
  });

  it("denies Tier 0 when successCount below threshold", () => {
    const r = heuristicClassify({
      ...baseFeatures,
      patternMatchScore: 0.95,
      patternMatchSuccessCount: 2, // needs >= 3
      patternMatchHealth: 0.97,
    });
    expect(r.tier).not.toBe(0);
  });

  it("picks Tier 3 when multi-file affected", () => {
    const r = heuristicClassify({ ...baseFeatures, affectedFileCount: 5 });
    expect(r.tier).toBe(3);
  });

  it("picks Tier 3 on repeated failure (prior remediations >= 3)", () => {
    const r = heuristicClassify({ ...baseFeatures, priorRemediationsForFingerprint: 3 });
    expect(r.tier).toBe(3);
  });

  it("picks Tier 1 for simple TypeError, single file, user code", () => {
    const r = heuristicClassify({ ...baseFeatures });
    expect(r.tier).toBe(1);
  });

  it("falls back to Tier 2 for Other category", () => {
    const r = heuristicClassify({ ...baseFeatures, errorCategory: "Other" });
    expect(r.tier).toBe(2);
  });

  it("falls back to Tier 2 when stack top is not user code", () => {
    const r = heuristicClassify({ ...baseFeatures, stackTopFrameUserCode: false });
    expect(r.tier).toBe(2);
  });

  it("returns confidence in [0,1]", () => {
    const r = heuristicClassify(baseFeatures);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
});

// ── extractRouterFeatures ───────────────────────────────────────────────────

describe("extractRouterFeatures", () => {
  const alertStub = {
    id: uuid("a"),
    title: "TypeError: foo",
    body: "at userFn (src/a.ts:1:1)\n    at other (node_modules/react/react.js:1:1)",
    severity: "error",
    fingerprint: "fp1",
    source_integrations: ["sentry"],
    session_id: null,
  };

  it("classifies TypeError", async () => {
    const f = await extractRouterFeatures(alertStub, [], null, 0);
    expect(f.errorCategory).toBe("TypeError");
  });

  it("classifies Network errors from message text", async () => {
    const f = await extractRouterFeatures(
      { ...alertStub, title: "fetch failed", body: "ECONNREFUSED" },
      [], null, 0,
    );
    expect(f.errorCategory).toBe("Network");
  });

  it("classifies DB errors", async () => {
    const f = await extractRouterFeatures(
      { ...alertStub, title: "postgres deadlock", body: "deadlock detected" },
      [], null, 0,
    );
    expect(f.errorCategory).toBe("DB");
  });

  it("classifies Auth errors", async () => {
    const f = await extractRouterFeatures(
      { ...alertStub, title: "401 Unauthorized", body: "jwt expired" },
      [], null, 0,
    );
    expect(f.errorCategory).toBe("Auth");
  });

  it("detects user code in stack top frame", async () => {
    const f = await extractRouterFeatures(alertStub, [], null, 0);
    expect(f.stackTopFrameUserCode).toBe(true);
  });

  it("excludes node_modules frames from file count", async () => {
    const f = await extractRouterFeatures(alertStub, [], null, 0);
    expect(f.affectedFileCount).toBe(1); // only src/a.ts counts
  });

  it("normalizes severity", async () => {
    const f = await extractRouterFeatures({ ...alertStub, severity: "CRITICAL" }, [], null, 0);
    expect(f.severity).toBe("critical");
  });

  it("uses best pattern match for score/successCount/health", async () => {
    const match: PatternMatch = {
      patternId: uuid("p"),
      score: 0.9,
      fixStrategy: null,
      filesTouched: [],
      successCount: 3,
      confidence: 0.9,
      postMergeHealth: 0.95,
      fromCommunity: false,
    };
    const f = await extractRouterFeatures(alertStub, [match], null, 0);
    expect(f.patternMatchScore).toBe(0.9);
    expect(f.patternMatchSuccessCount).toBe(3);
    expect(f.patternMatchHealth).toBe(0.95);
  });

  it("detects hasSubstrateRecording from context", async () => {
    const f = await extractRouterFeatures(alertStub, [], { substrateRecordingId: "r1" }, 0);
    expect(f.hasSubstrateRecording).toBe(true);
  });

  it("detects hasCaptureBreadcrumbs", async () => {
    const f = await extractRouterFeatures(alertStub, [], { breadcrumbs: [{}, {}] }, 0);
    expect(f.hasCaptureBreadcrumbs).toBe(true);
  });
});

// ── classifyTier ────────────────────────────────────────────────────────────

describe("classifyTier", () => {
  const logCtx = {
    userId: uuid("u"),
    projectId: uuid("p"),
    alertId: uuid("a"),
    remediationSessionId: uuid("s"),
  };

  it("returns heuristic when no api key available", async () => {
    delete process.env.PLATFORM_AI_KEY;
    delete process.env.OPENAI_API_KEY;
    const r = await classifyTier(baseFeatures, logCtx);
    expect(r.usedFallback).toBe(true);
    expect(callAIMock).not.toHaveBeenCalled();
  });

  it("uses model when api key present and output valid", async () => {
    callAIMock.mockResolvedValue('{"tier":2,"reason":"complex fix","confidence":0.85}');
    const r = await classifyTier(baseFeatures, logCtx);
    expect(r.usedFallback).toBe(false);
    expect(r.tier).toBe(2);
  });

  it("falls through to heuristic on malformed model output", async () => {
    callAIMock.mockResolvedValue("I think it's tier 2");
    const r = await classifyTier(baseFeatures, logCtx);
    expect(r.usedFallback).toBe(true);
  });

  it("falls through to heuristic on low classifier confidence (< 0.6)", async () => {
    callAIMock.mockResolvedValue('{"tier":1,"reason":"not sure","confidence":0.3}');
    const r = await classifyTier(baseFeatures, logCtx);
    expect(r.usedFallback).toBe(true);
  });

  it("falls through to heuristic on call error", async () => {
    callAIMock.mockRejectedValue(new Error("OpenAI timeout"));
    const r = await classifyTier(baseFeatures, logCtx);
    expect(r.usedFallback).toBe(true);
  });

  it("opens circuit after 3 errors in 60s", async () => {
    callAIMock.mockRejectedValue(new Error("boom"));
    await classifyTier(baseFeatures, logCtx);
    await classifyTier(baseFeatures, logCtx);
    await classifyTier(baseFeatures, logCtx);
    callAIMock.mockReset();
    callAIMock.mockResolvedValue('{"tier":2,"reason":"x","confidence":0.9}');
    const r = await classifyTier(baseFeatures, logCtx);
    // circuit is open — no model call, heuristic used
    expect(callAIMock).not.toHaveBeenCalled();
    expect(r.usedFallback).toBe(true);
  });
});

// ── routeTier ───────────────────────────────────────────────────────────────

describe("routeTier", () => {
  it("returns null when TIER_ROUTER_MODE='off' (byte-identical guarantee)", async () => {
    delete process.env.TIER_ROUTER_MODE;
    const r = await routeTier(uuid("a"), uuid("s"));
    expect(r).toBeNull();
    expect(executeMock).not.toHaveBeenCalled();
    expect(callAIMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("returns null when session missing", async () => {
    process.env.TIER_ROUTER_MODE = "shadow";
    executeMock.mockResolvedValueOnce(rowsResult([])); // loadSession → empty
    const r = await routeTier(uuid("a"), uuid("s"));
    expect(r).toBeNull();
  });

  it("persists tier_used and pattern_match_score in shadow mode", async () => {
    process.env.TIER_ROUTER_MODE = "shadow";
    callAIMock.mockResolvedValue('{"tier":2,"reason":"ok","confidence":0.9}');

    // routeTier query order (when all paths taken):
    //   1. loadSession   — SELECT ... FROM remediation_sessions
    //   2. loadAlert     — SELECT ... FROM alerts
    //   3. countPriorRemediations — SELECT COUNT(*) ...
    //   4. resolveSessionUserId (for lookup logging) — SELECT user_id ...
    //   5. lookupPattern is mocked, so no execute calls inside it
    //   6. resolveSessionUserId (for classifier logging) — SELECT user_id ...
    executeMock
      .mockResolvedValueOnce(rowsResult([{ // loadSession
        id: uuid("s"), project_id: uuid("p"), alert_id: uuid("a"), context: null, repo: null,
      }]))
      .mockResolvedValueOnce(rowsResult([{ // loadAlert
        id: uuid("a"), title: "TypeError: x", body: "at userFn (src/a.ts:1:1)",
        severity: "medium", fingerprint: "fp", source_integrations: ["sentry"], session_id: null,
      }]))
      .mockResolvedValueOnce(rowsResult([{ count: 0 }])) // countPriorRemediations
      .mockResolvedValueOnce(rowsResult([{ user_id: uuid("u") }])) // resolveSessionUserId #1
      .mockResolvedValueOnce(rowsResult([{ user_id: uuid("u") }])); // resolveSessionUserId #2

    const r = await routeTier(uuid("a"), uuid("s"));
    expect(r).not.toBeNull();
    expect(updateSetMock).toHaveBeenCalled();
    const setArg = updateSetMock.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.tierUsed).toBe(String(r!.tier));
  });
});

// ── meetsTier0PromotionGate ─────────────────────────────────────────────────

describe("meetsTier0PromotionGate", () => {
  const base: PatternMatch = {
    patternId: uuid("p"),
    score: 0.95,
    fixStrategy: null,
    filesTouched: [],
    successCount: 3,
    confidence: 0.95,
    postMergeHealth: 0.96,
    fromCommunity: false,
  };

  it("passes strict thresholds", () => {
    expect(meetsTier0PromotionGate(base)).toBe(true);
  });
  it("fails when score < 0.92", () => {
    expect(meetsTier0PromotionGate({ ...base, score: 0.91 })).toBe(false);
  });
  it("fails when successCount < 3", () => {
    expect(meetsTier0PromotionGate({ ...base, successCount: 2 })).toBe(false);
  });
  it("fails when postMergeHealth < 0.95", () => {
    expect(meetsTier0PromotionGate({ ...base, postMergeHealth: 0.94 })).toBe(false);
  });
  it("fails when postMergeHealth null", () => {
    expect(meetsTier0PromotionGate({ ...base, postMergeHealth: null })).toBe(false);
  });
});
