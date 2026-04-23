import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

const executeMock = vi.fn();
const insertValuesMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => ({
  db: {
    execute: (...args: unknown[]) => executeMock(...args),
    insert: () => ({ values: insertValuesMock }),
  },
  aiUsageLogs: Symbol("aiUsageLogs"),
}));

const embedQueryMock = vi.fn();
vi.mock("@/lib/code-intelligence/embeddings", () => ({
  embedQuery: (...args: unknown[]) => embedQueryMock(...args),
}));

const redisIncrMock = vi.fn();
const redisExpireMock = vi.fn();
const redisDelMock = vi.fn();
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    incr: redisIncrMock,
    expire: redisExpireMock,
    del: redisDelMock,
  }),
}));

// Import AFTER mocks
import {
  buildEmbeddingText,
  lookupPattern,
  writePattern,
  decayPattern,
  disablePattern,
  recordPatternRegression,
  __resetPatternMemoryCircuit,
  PATTERN_FAIL_TTL_SECONDS,
  type PatternInputAlert,
  type PatternInputSession,
} from "../pattern-memory";

// ── Fixtures ────────────────────────────────────────────────────────────────

// Hex-only UUIDs so the UUID_RE guard in recordPatternRegression passes.
// Deterministic per-label so assertions across calls match.
const uuidMap = new Map<string, string>();
const uuid = (label: string) => {
  let v = uuidMap.get(label);
  if (v) return v;
  const hex = (uuidMap.size + 1).toString(16).padStart(8, "0");
  v = `${hex}-0000-0000-0000-000000000000`;
  uuidMap.set(label, v);
  return v;
};

const baseAlert: PatternInputAlert = {
  id: uuid("alert"),
  title: "TypeError: Cannot read properties of undefined",
  body: "at renderItems (src/components/List.tsx:42:18)\n  at List (src/components/List.tsx:28:5)",
  fingerprint: "abc123def456",
  sourceIntegrations: ["sentry"],
};

const baseSession: PatternInputSession = {
  id: uuid("sess"),
  projectId: uuid("proj"),
  alertId: uuid("alert"),
  userId: uuid("user"),
  fingerprint: "abc123def456",
  fileChanges: [{ path: "src/components/List.tsx", content: "..." }],
  confidenceScore: 88,
  context: null,
};

// Helper to wrap mocked db.execute rows
const rowsResult = <T>(rows: T[]) => Object.assign([...rows], { rows });

beforeEach(() => {
  executeMock.mockReset();
  insertValuesMock.mockReset().mockResolvedValue(undefined);
  embedQueryMock.mockReset();
  redisIncrMock.mockReset();
  redisExpireMock.mockReset();
  redisDelMock.mockReset();
  __resetPatternMemoryCircuit();
  delete process.env.PATTERN_MEMORY_READ_ENABLED;
  delete process.env.PATTERN_MEMORY_WRITE_ENABLED;
  delete process.env.PATTERN_MEMORY_KILL_SWITCH;
  process.env.PLATFORM_AI_KEY = "test-key";
});

afterEach(() => {
  delete process.env.PLATFORM_AI_KEY;
});

// ── buildEmbeddingText ──────────────────────────────────────────────────────

describe("buildEmbeddingText", () => {
  it("includes all 4 sections in fixed order", () => {
    const out = buildEmbeddingText(baseAlert);
    expect(out).toMatch(/^\[INTEGRATION\] sentry\n\[TITLE\] /);
    expect(out).toContain("[BODY] at renderItems");
    expect(out).toContain("[FINGERPRINT] abc123def456");
  });

  it("falls back to 'unknown' when sourceIntegrations empty", () => {
    const out = buildEmbeddingText({ ...baseAlert, sourceIntegrations: [] });
    expect(out).toMatch(/^\[INTEGRATION\] unknown\n/);
  });

  it("falls back to 'none' when fingerprint null", () => {
    const out = buildEmbeddingText({ ...baseAlert, fingerprint: null });
    expect(out).toContain("[FINGERPRINT] none");
  });

  it("truncates body to 4096 chars", () => {
    const huge = "x".repeat(10_000);
    const out = buildEmbeddingText({ ...baseAlert, body: huge });
    const bodyMatch = out.match(/\[BODY\] (x+)\n/);
    expect(bodyMatch?.[1].length).toBe(4096);
  });

  it("is deterministic — same input yields same output (symmetry for read/write)", () => {
    expect(buildEmbeddingText(baseAlert)).toBe(buildEmbeddingText(baseAlert));
  });
});

// ── lookupPattern ───────────────────────────────────────────────────────────

describe("lookupPattern — flag gating", () => {
  it("returns [] when PATTERN_MEMORY_READ_ENABLED is unset (default)", async () => {
    const out = await lookupPattern(baseAlert, { projectId: baseSession.projectId });
    expect(out).toEqual([]);
    expect(embedQueryMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns [] when kill switch is set even if read is enabled", async () => {
    process.env.PATTERN_MEMORY_READ_ENABLED = "true";
    process.env.PATTERN_MEMORY_KILL_SWITCH = "true";
    const out = await lookupPattern(baseAlert, { projectId: baseSession.projectId });
    expect(out).toEqual([]);
  });

  it("returns [] when no embedding API key is available", async () => {
    process.env.PATTERN_MEMORY_READ_ENABLED = "true";
    delete process.env.PLATFORM_AI_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const out = await lookupPattern(baseAlert, { projectId: baseSession.projectId });
    expect(out).toEqual([]);
  });

  it("returns [] when embedding generation fails", async () => {
    process.env.PATTERN_MEMORY_READ_ENABLED = "true";
    embedQueryMock.mockResolvedValue(null);
    const out = await lookupPattern(baseAlert, { projectId: baseSession.projectId });
    expect(out).toEqual([]);
  });

  it("throws on malformed projectId", async () => {
    process.env.PATTERN_MEMORY_READ_ENABLED = "true";
    await expect(
      lookupPattern(baseAlert, { projectId: "not-a-uuid" }),
    ).rejects.toThrow(/projectId/);
  });

  it("filters matches below minScore", async () => {
    process.env.PATTERN_MEMORY_READ_ENABLED = "true";
    embedQueryMock.mockResolvedValue(new Array(1024).fill(0.1));
    executeMock.mockResolvedValue(rowsResult([
      { id: uuid("pat1"), distance: 0.05, fix_strategy: null, files_touched: [], success_count: 1, confidence: 0.9, post_merge_health_score: 1.0 }, // score ~0.975
      { id: uuid("pat2"), distance: 0.30, fix_strategy: null, files_touched: [], success_count: 1, confidence: 0.8, post_merge_health_score: 1.0 }, // score 0.85 → below default 0.88
    ]));
    const out = await lookupPattern(baseAlert, { projectId: baseSession.projectId });
    expect(out).toHaveLength(1);
    expect(out[0].patternId).toBe(uuid("pat1"));
  });

  it("maps cosine distance to similarity in [0, 1]", async () => {
    process.env.PATTERN_MEMORY_READ_ENABLED = "true";
    embedQueryMock.mockResolvedValue(new Array(1024).fill(0.1));
    executeMock.mockResolvedValue(rowsResult([
      { id: uuid("p"), distance: 0.0, fix_strategy: null, files_touched: [], success_count: 1, confidence: 1.0, post_merge_health_score: 1.0 },
    ]));
    const out = await lookupPattern(baseAlert, { projectId: baseSession.projectId, minScore: 0 });
    expect(out[0].score).toBe(1);
  });

  it("returns [] on DB failure", async () => {
    process.env.PATTERN_MEMORY_READ_ENABLED = "true";
    embedQueryMock.mockResolvedValue(new Array(1024).fill(0.1));
    executeMock.mockRejectedValue(new Error("Neon timeout"));
    const out = await lookupPattern(baseAlert, { projectId: baseSession.projectId });
    expect(out).toEqual([]);
  });

  it("logs ai_usage_logs row with phase=pattern_lookup when userId given", async () => {
    process.env.PATTERN_MEMORY_READ_ENABLED = "true";
    embedQueryMock.mockResolvedValue(new Array(1024).fill(0.1));
    executeMock.mockResolvedValue(rowsResult([]));
    await lookupPattern(
      baseAlert,
      { projectId: baseSession.projectId },
      { userId: uuid("user"), remediationSessionId: uuid("sess") },
    );
    expect(insertValuesMock).toHaveBeenCalledOnce();
    const row = insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.phase).toBe("pattern_lookup");
    expect(row.feature).toBe("remediation");
  });
});

// ── writePattern ────────────────────────────────────────────────────────────

describe("writePattern — skip cases", () => {
  it("skips flag_off when PATTERN_MEMORY_WRITE_ENABLED=false", async () => {
    process.env.PATTERN_MEMORY_WRITE_ENABLED = "false";
    const out = await writePattern(baseSession, { postMergeHealthScore: 1.0 });
    expect(out).toEqual({ action: "skipped", reason: "flag_off" });
    expect(embedQueryMock).not.toHaveBeenCalled();
  });

  it("skips health_below_threshold when score < 0.9", async () => {
    const out = await writePattern(baseSession, { postMergeHealthScore: 0.85 });
    expect(out).toEqual({ action: "skipped", reason: "health_below_threshold" });
  });

  it("skips no_fingerprint when session lacks one", async () => {
    const out = await writePattern(
      { ...baseSession, fingerprint: null },
      { postMergeHealthScore: 1.0 },
    );
    expect(out).toEqual({ action: "skipped", reason: "no_fingerprint" });
  });

  it("clamps out-of-range health scores and still skips when below threshold", async () => {
    const out = await writePattern(baseSession, { postMergeHealthScore: -0.5 });
    expect(out).toEqual({ action: "skipped", reason: "health_below_threshold" });
  });
});

// Note: writePattern issues a fixed query order when not flag-skipped:
//   1. SELECT ... FROM alerts (loadAlertForEmbedding)
//   2. SELECT id, success_count ... FROM pattern_memory (existing row probe)
//   3a. INSERT INTO pattern_memory (new row path) ... RETURNING id
//    or 3b. UPDATE pattern_memory (existing row path)
// Drizzle's sql`` objects don't serialize to readable strings, so tests rely
// on this ordering via mockResolvedValueOnce.

describe("writePattern — insert path", () => {
  it("inserts a new pattern when fingerprint is unseen", async () => {
    embedQueryMock.mockResolvedValue(new Array(1024).fill(0.1));
    executeMock
      .mockResolvedValueOnce(rowsResult([{
        id: baseAlert.id, title: baseAlert.title, body: baseAlert.body,
        fingerprint: baseAlert.fingerprint, sourceIntegrations: baseAlert.sourceIntegrations,
      }])) // loadAlertForEmbedding
      .mockResolvedValueOnce(rowsResult([])) // no existing row
      .mockResolvedValueOnce(rowsResult([{ id: uuid("newp") }])); // INSERT RETURNING
    const out = await writePattern(baseSession, { postMergeHealthScore: 1.0 });
    expect(out.action).toBe("inserted");
    if (out.action === "inserted") expect(out.patternId).toBe(uuid("newp"));
  });
});

describe("writePattern — existing row paths", () => {
  it("increments success_count when row exists and not disabled", async () => {
    embedQueryMock.mockResolvedValue(new Array(1024).fill(0.1));
    executeMock
      .mockResolvedValueOnce(rowsResult([{
        id: baseAlert.id, title: baseAlert.title, body: baseAlert.body,
        fingerprint: baseAlert.fingerprint, sourceIntegrations: baseAlert.sourceIntegrations,
      }])) // loadAlertForEmbedding
      .mockResolvedValueOnce(rowsResult([{
        id: uuid("existing"),
        success_count: 4,
        post_merge_health_score: 0.95,
        disabled_at: null,
      }])) // existing probe
      .mockResolvedValueOnce(rowsResult([])); // UPDATE

    const out = await writePattern(baseSession, { postMergeHealthScore: 0.92 });
    expect(out.action).toBe("updated");
    if (out.action === "updated") {
      expect(out.newSuccessCount).toBe(5);
      expect(out.patternId).toBe(uuid("existing"));
    }
    // UPDATE was issued (3rd execute call)
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it("returns pattern_disabled (no auto-revive) when existing row is disabled", async () => {
    embedQueryMock.mockResolvedValue(new Array(1024).fill(0.1));
    executeMock
      .mockResolvedValueOnce(rowsResult([{
        id: baseAlert.id, title: baseAlert.title, body: baseAlert.body,
        fingerprint: baseAlert.fingerprint, sourceIntegrations: baseAlert.sourceIntegrations,
      }])) // loadAlertForEmbedding
      .mockResolvedValueOnce(rowsResult([{
        id: uuid("disp"),
        success_count: 2,
        post_merge_health_score: 0.8,
        disabled_at: new Date("2026-01-01"),
      }])); // existing probe — disabled

    const out = await writePattern(baseSession, { postMergeHealthScore: 1.0 });
    expect(out).toEqual({ action: "skipped", reason: "pattern_disabled" });
    // No UPDATE — only the 2 SELECTs ran
    expect(executeMock).toHaveBeenCalledTimes(2);
    // pattern_disable_conflict telemetry row written
    const phases = insertValuesMock.mock.calls.map((c) => (c[0] as Record<string, unknown>).phase);
    expect(phases).toContain("pattern_disable_conflict");
  });
});

// ── decayPattern ────────────────────────────────────────────────────────────

describe("decayPattern", () => {
  it("is a no-op when weeksIdle <= 12", async () => {
    const recent = new Date(Date.now() - 4 * 7 * 24 * 3600 * 1000);
    executeMock.mockResolvedValueOnce(rowsResult([{ confidence: 0.8, last_used_at: recent }]));
    const out = await decayPattern(uuid("p"));
    expect(out.newConfidence).toBe(0.8);
    expect(out.oldConfidence).toBe(0.8);
  });

  it("applies 0.9^(weeksIdle - 12) decay past the 12w floor", async () => {
    const longAgo = new Date(Date.now() - 16 * 7 * 24 * 3600 * 1000); // 16 weeks
    executeMock
      .mockResolvedValueOnce(rowsResult([{ confidence: 1.0, last_used_at: longAgo }]))
      .mockResolvedValueOnce(rowsResult([]));
    const out = await decayPattern(uuid("p"));
    expect(out.weeksIdle).toBeGreaterThanOrEqual(16);
    // 0.9^4 ≈ 0.6561; allow some float tolerance
    expect(out.newConfidence).toBeCloseTo(0.6561, 2);
  });

  it("clamps at DECAY_MIN_CONFIDENCE (0.1) for very old patterns", async () => {
    const ancient = new Date(Date.now() - 520 * 7 * 24 * 3600 * 1000); // 10 years
    executeMock
      .mockResolvedValueOnce(rowsResult([{ confidence: 0.9, last_used_at: ancient }]))
      .mockResolvedValueOnce(rowsResult([]));
    const out = await decayPattern(uuid("p"));
    expect(out.newConfidence).toBe(0.1);
  });

  it("returns {0,0,0} for nonexistent pattern", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([]));
    const out = await decayPattern(uuid("p"));
    expect(out).toEqual({ oldConfidence: 0, newConfidence: 0, weeksIdle: 0 });
  });
});

// ── disablePattern ──────────────────────────────────────────────────────────

describe("disablePattern", () => {
  it("disables a pattern that's not already disabled", async () => {
    executeMock
      .mockResolvedValueOnce(rowsResult([{ disabled_at: null }]))
      .mockResolvedValueOnce(rowsResult([]));
    const out = await disablePattern(uuid("p"), "critical_regression");
    expect(out).toEqual({ disabled: true, alreadyDisabled: false });
  });

  it("reports alreadyDisabled when disabled_at is set", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ disabled_at: new Date() }]));
    const out = await disablePattern(uuid("p"), "manual");
    expect(out).toEqual({ disabled: false, alreadyDisabled: true });
  });

  it("returns {false,false} for unknown pattern", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([]));
    const out = await disablePattern(uuid("p"), "manual");
    expect(out).toEqual({ disabled: false, alreadyDisabled: false });
  });
});

// ── recordPatternRegression ─────────────────────────────────────────────────

describe("recordPatternRegression", () => {
  it("is a no-op when no session exists (future-ready)", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([]));
    await expect(recordPatternRegression(uuid("a"), "high")).resolves.toBeUndefined();
    expect(redisIncrMock).not.toHaveBeenCalled();
  });

  it("is a no-op when checkpoint_data lacks patternIdUsed", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ checkpoint_data: { other: "stuff" } }]));
    await recordPatternRegression(uuid("a"), "high");
    expect(redisIncrMock).not.toHaveBeenCalled();
  });

  it("disables immediately for critical severity", async () => {
    executeMock
      .mockResolvedValueOnce(rowsResult([{ checkpoint_data: { patternIdUsed: uuid("p") } }]))
      .mockResolvedValueOnce(rowsResult([{ disabled_at: null }]))
      .mockResolvedValueOnce(rowsResult([]));
    await recordPatternRegression(uuid("a"), "CRITICAL");
    expect(redisIncrMock).not.toHaveBeenCalled();
  });

  it("increments counter and disables on reaching 3 consecutive fails", async () => {
    redisIncrMock.mockResolvedValueOnce(3);
    executeMock
      .mockResolvedValueOnce(rowsResult([{ checkpoint_data: { patternIdUsed: uuid("p") } }]))
      .mockResolvedValueOnce(rowsResult([{ disabled_at: null }]))
      .mockResolvedValueOnce(rowsResult([]));
    await recordPatternRegression(uuid("a"), "high");
    expect(redisIncrMock).toHaveBeenCalledWith(`pattern:fail:${uuid("p")}`);
    expect(redisExpireMock).toHaveBeenCalledWith(`pattern:fail:${uuid("p")}`, PATTERN_FAIL_TTL_SECONDS);
  });

  it("only increments when count < 3", async () => {
    redisIncrMock.mockResolvedValueOnce(1);
    executeMock.mockResolvedValueOnce(rowsResult([{ checkpoint_data: { patternIdUsed: uuid("p") } }]));
    await recordPatternRegression(uuid("a"), "medium");
    expect(redisIncrMock).toHaveBeenCalledOnce();
  });
});
