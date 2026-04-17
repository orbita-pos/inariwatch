/**
 * Tests for getOrComputeWhatIf — the cache + compute orchestrator
 * powering the AI panel's What-If button.
 *
 * Pinned behaviour:
 *   - Cache hit returns the stored row with fromCache=true (no AI cost)
 *   - Cache miss → compute → cache write → return fromCache=false
 *   - Failed compute returns null AND does not poison the cache
 *   - deriveOutcome thresholds (would_prevent / uncertain / would_not_prevent)
 *
 * The chainable-thenable mock pattern is identical to alert-impact and
 * context-for-prompt — Drizzle's fluent query API resolves to whatever
 * is queued without needing per-call schema knowledge.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let queryQueue: unknown[][] = [];
const insertCalls: unknown[] = [];
const updateCalls: unknown[] = [];

// vi.mock is hoisted before module-scope declarations — so the mock factory
// can't capture a top-level `vi.fn()`. vi.hoisted is the official escape hatch:
// the mock fn is created in the same hoisting phase as the mock declarations.
const { analyzeReplayMock } = vi.hoisted(() => ({
  analyzeReplayMock: vi.fn(),
}));

function chainable() {
  const obj: Record<string, unknown> = {};
  const methods = ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy", "set"];
  for (const m of methods) obj[m] = () => obj;
  obj.then = (resolve: (v: unknown) => void) => resolve(queryQueue.shift() ?? []);
  return obj;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chainable(),
    insert: () => ({
      values: (v: unknown) => ({
        onConflictDoNothing: () => {
          insertCalls.push(v);
          return Promise.resolve();
        },
      }),
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: () => {
          updateCalls.push(v);
          return Promise.resolve();
        },
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  whatifReplays: {
    sessionId: "session_id",
    fixCommitSha: "fix_commit_sha",
    result: "result",
    computedAt: "computed_at",
    lastAccessedAt: "last_accessed_at",
  },
  // substrateRecordings is imported at module-load time via what-if.ts;
  // the worker-path tests never read it (they short-circuit before the
  // local substrate fallback), so an empty marker object is enough to
  // keep the import resolution happy.
  substrateRecordings: {
    recordingId: "recording_id",
    events: "events",
    command: "command",
    runtime: "runtime",
    startedAt: "started_at",
    endedAt: "ended_at",
    sessionId: "session_id",
  },
}));

vi.mock("@/lib/ai/substrate-replay", () => ({
  analyzeReplay: analyzeReplayMock,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: ((c: unknown, v: unknown) => ({ c, v })) as unknown as typeof actual.eq,
    and: ((...args: unknown[]) => ({ and: args })) as unknown as typeof actual.and,
  };
});

import { getOrComputeWhatIf, readCache } from "@/lib/services/what-if";

const baseInput = {
  sessionId: "sess-1",
  fixCommitSha: "abc1234",
  remediationId: "rem-uuid-1",
  alertId: "alert-uuid-1",
  projectId: "proj-uuid-1",
  diagnosis: "Stripe API timed out without retry logic",
  fixFiles: [{ path: "src/checkout.ts", content: "// fixed" }],
  apiKey: "sk-test",
  provider: "openai" as const,
  model: "gpt-4o-mini",
  userId: "user-1",
};

beforeEach(() => {
  queryQueue = [];
  insertCalls.length = 0;
  updateCalls.length = 0;
  analyzeReplayMock.mockReset();
});

// ── Cache hit ──────────────────────────────────────────────────────────────

describe("getOrComputeWhatIf — cache hit", () => {
  it("returns cached row with fromCache=true and skips AI compute", async () => {
    const cachedAt = new Date("2026-04-16T20:00:00Z");
    queryQueue = [
      [{
        result: {
          outcome: "would_prevent",
          confidence: 87,
          riskScore: 22,
          analysis: "Idempotency key prevents duplicate Stripe calls.",
          mode: "ai_analysis",
          computedAt: cachedAt.toISOString(),
        },
        computedAt: cachedAt,
      }],
    ];

    const r = await getOrComputeWhatIf(baseInput);

    expect(r).toMatchObject({
      outcome: "would_prevent",
      confidence: 87,
      riskScore: 22,
      fromCache: true,
    });
    expect(analyzeReplayMock).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it("readCache returns null on miss", async () => {
    queryQueue = [[]];
    const r = await readCache("sess-x", "abc");
    expect(r).toBeNull();
  });

  it("readCache fires last_accessed_at update fire-and-forget", async () => {
    const cachedAt = new Date("2026-04-15T00:00:00Z");
    queryQueue = [
      [{
        result: { outcome: "would_prevent", confidence: 90, riskScore: 10, analysis: "x", mode: "ai_analysis", computedAt: cachedAt.toISOString() },
        computedAt: cachedAt,
      }],
    ];
    await readCache("sess-1", "abc");
    // Update was invoked (fire-and-forget; we just check it ran).
    expect(updateCalls.length).toBeGreaterThan(0);
  });
});

// ── Cache miss → compute ───────────────────────────────────────────────────

describe("getOrComputeWhatIf — cache miss + compute", () => {
  it("computes via analyzeReplay, writes to cache, returns fromCache=false", async () => {
    queryQueue = [[]]; // miss
    analyzeReplayMock.mockResolvedValue({
      passed: true,
      confidence: 85,
      riskScore: 25,
      analysis: "The retry path with idempotency key handles the timeout.",
      replayedEvents: 6,
      mode: "ai_analysis",
    });

    const r = await getOrComputeWhatIf(baseInput);

    expect(r).toMatchObject({
      outcome: "would_prevent",
      confidence: 85,
      riskScore: 25,
      mode: "ai_analysis",
      fromCache: false,
    });
    expect(analyzeReplayMock).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);
  });

  it("returns null when analyzeReplay returns null (no recording)", async () => {
    queryQueue = [[]]; // miss
    analyzeReplayMock.mockResolvedValue(null);

    const r = await getOrComputeWhatIf(baseInput);
    expect(r).toBeNull();
    // No cache write — nothing to cache.
    expect(insertCalls).toHaveLength(0);
  });

  it("passes sessionId through to analyzeReplay (so frontend journey can be loaded)", async () => {
    queryQueue = [[]];
    analyzeReplayMock.mockResolvedValue({
      passed: true, confidence: 70, riskScore: 30, analysis: "x", replayedEvents: 1, mode: "ai_analysis",
    });
    await getOrComputeWhatIf(baseInput);
    // analyzeReplay's last arg is the replay session id.
    const call = analyzeReplayMock.mock.calls[0];
    expect(call[call.length - 1]).toBe("sess-1");
  });

  it("forwards platform-key flag for cost attribution", async () => {
    queryQueue = [[]];
    analyzeReplayMock.mockResolvedValue({
      passed: true, confidence: 80, riskScore: 20, analysis: "x", replayedEvents: 1, mode: "ai_analysis",
    });
    await getOrComputeWhatIf({ ...baseInput, isPlatformKey: true });
    const logCtxArg = analyzeReplayMock.mock.calls[0][7];
    expect(logCtxArg).toMatchObject({ isPlatformKey: true });
  });
});

// ── Outcome derivation ────────────────────────────────────────────────────

describe("getOrComputeWhatIf — outcome derivation", () => {
  async function runWith(passed: boolean, confidence: number, riskScore: number) {
    queryQueue = [[]];
    analyzeReplayMock.mockResolvedValue({
      passed, confidence, riskScore, analysis: "x", replayedEvents: 1, mode: "ai_analysis",
    });
    return getOrComputeWhatIf(baseInput);
  }

  it("passed=true + high confidence + low risk = would_prevent", async () => {
    const r = await runWith(true, 80, 30);
    expect(r?.outcome).toBe("would_prevent");
  });

  it("passed=true but confidence < 60 = uncertain", async () => {
    const r = await runWith(true, 55, 30);
    expect(r?.outcome).toBe("uncertain");
  });

  it("passed=true but riskScore > 40 = uncertain", async () => {
    const r = await runWith(true, 80, 50);
    expect(r?.outcome).toBe("uncertain");
  });

  it("passed=false + high confidence = would_not_prevent", async () => {
    const r = await runWith(false, 75, 60);
    expect(r?.outcome).toBe("would_not_prevent");
  });

  it("passed=false but low confidence = uncertain (don't claim a fail you're unsure of)", async () => {
    const r = await runWith(false, 40, 50);
    expect(r?.outcome).toBe("uncertain");
  });
});

// ── Worker path (Sesión 5B-2) ─────────────────────────────────────────────

describe("getOrComputeWhatIf — Hetzner worker path", () => {
  const originalFetch = global.fetch;
  const originalWorkerUrl = process.env.WORKER_URL;
  const originalSecret = process.env.STAGING_API_SECRET;

  beforeEach(() => {
    process.env.WORKER_URL = "https://worker.inari.test";
    process.env.STAGING_API_SECRET = "test-secret";
  });

  function restoreEnv() {
    if (originalWorkerUrl === undefined) delete process.env.WORKER_URL;
    else process.env.WORKER_URL = originalWorkerUrl;
    if (originalSecret === undefined) delete process.env.STAGING_API_SECRET;
    else process.env.STAGING_API_SECRET = originalSecret;
    global.fetch = originalFetch;
  }

  const workerInput = {
    ...baseInput,
    githubToken: "ghp_fake_token",
  };

  it("calls /worker/whatif with bearer auth and maps matched response to substrate_replay result", async () => {
    queryQueue = [[]]; // cache miss

    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        matched: true,
        eventCountBefore: 12,
        eventCountAfter: 12,
        riskScore: 15,
        riskLevel: "low",
        blastRadius: { httpPaths: ["/api/checkout"], dbTables: [], filePaths: [], totalSurfaces: 1 },
        recommendations: ["Replay matched — fix preserves recorded behavior."],
        detectedCommand: "npm start",
        commandSource: "npm_start",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const r = await getOrComputeWhatIf(workerInput);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://worker.inari.test/worker/whatif");
      expect((opts as RequestInit).method).toBe("POST");
      expect((opts as RequestInit).headers).toMatchObject({
        Authorization: "Bearer test-secret",
      });

      expect(r).toMatchObject({
        outcome: "would_prevent",
        mode: "substrate_replay",
        confidence: 95,
        riskScore: 15,
        fromCache: false,
      });
      expect(r?.substrate).toMatchObject({
        matched: true,
        riskLevel: "low",
        blastRadius: { totalSurfaces: 1 },
      });
      // AI path must NOT be invoked when worker succeeds — that's the
      // entire cost savings of this integration.
      expect(analyzeReplayMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("falls back to AI when worker returns no_recording", async () => {
    queryQueue = [[]]; // cache miss

    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: "no_recording", error: "no recording for session" }),
      { status: 422 },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;
    analyzeReplayMock.mockResolvedValue({
      passed: true, confidence: 80, riskScore: 30, analysis: "AI guess.", replayedEvents: 1, mode: "ai_analysis",
    });

    try {
      const r = await getOrComputeWhatIf(workerInput);
      expect(r?.mode).toBe("ai_analysis");
      expect(analyzeReplayMock).toHaveBeenCalledTimes(1);
    } finally {
      restoreEnv();
    }
  });

  it("falls back to AI when worker reports substrate_not_configured", async () => {
    queryQueue = [[]];
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: "substrate_not_configured", error: "binary missing" }),
      { status: 503 },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;
    analyzeReplayMock.mockResolvedValue({
      passed: true, confidence: 72, riskScore: 25, analysis: "AI covered.", replayedEvents: 1, mode: "ai_analysis",
    });

    try {
      const r = await getOrComputeWhatIf(workerInput);
      expect(r?.mode).toBe("ai_analysis");
    } finally {
      restoreEnv();
    }
  });

  it("skips worker entirely when githubToken is missing", async () => {
    queryQueue = [[]];
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    analyzeReplayMock.mockResolvedValue({
      passed: true, confidence: 70, riskScore: 40, analysis: "AI.", replayedEvents: 1, mode: "ai_analysis",
    });

    try {
      // Intentionally omit githubToken — worker gate requires it.
      await getOrComputeWhatIf(baseInput);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(analyzeReplayMock).toHaveBeenCalledTimes(1);
    } finally {
      restoreEnv();
    }
  });

  it("skips worker when WORKER_URL is plain http:// (non-localhost)", async () => {
    process.env.WORKER_URL = "http://untrusted.example.com";
    queryQueue = [[]];
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    analyzeReplayMock.mockResolvedValue({
      passed: true, confidence: 70, riskScore: 30, analysis: "AI.", replayedEvents: 1, mode: "ai_analysis",
    });

    try {
      await getOrComputeWhatIf(workerInput);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(analyzeReplayMock).toHaveBeenCalledTimes(1);
    } finally {
      restoreEnv();
    }
  });

  it("maps matched=false + critical risk to would_not_prevent with confidence 70", async () => {
    queryQueue = [[]];
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        matched: false,
        eventCountBefore: 8,
        eventCountAfter: 5,
        riskScore: 85,
        riskLevel: "critical",
        blastRadius: { httpPaths: ["/api/checkout", "/api/refund"], dbTables: ["orders"], filePaths: [], totalSurfaces: 3 },
        recommendations: ["Divergence detected on /api/refund — review before merging."],
        detectedCommand: "node server.js",
        commandSource: "node_entry",
      }),
      { status: 200 },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const r = await getOrComputeWhatIf(workerInput);
      expect(r).toMatchObject({
        outcome: "would_not_prevent",
        mode: "substrate_replay",
        confidence: 70,
        riskScore: 85,
      });
    } finally {
      restoreEnv();
    }
  });

  it("caches worker result under substrate_replay mode", async () => {
    queryQueue = [[]];
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        matched: true,
        eventCountBefore: 3, eventCountAfter: 3,
        riskScore: 10, riskLevel: "low",
        blastRadius: { httpPaths: [], dbTables: [], filePaths: [], totalSurfaces: 0 },
        recommendations: [],
        detectedCommand: "npm start",
        commandSource: "npm_start",
      }),
      { status: 200 },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await getOrComputeWhatIf(workerInput);
      expect(insertCalls).toHaveLength(1);
      const inserted = insertCalls[0] as { result: { mode: string } };
      expect(inserted.result.mode).toBe("substrate_replay");
    } finally {
      restoreEnv();
    }
  });
});
