/**
 * Tests for the Fase 1 telemetry fields on lens.ts:
 * turnNumber, ttftMs, phase, modelTier, toolName, toolExecMs, reasoningTokens.
 *
 * Asserts that the lens logger forwards every field to the Drizzle insert
 * and that absent fields default to null (not undefined) so the DB column
 * constraints stay happy.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const insertSpy = vi.fn<(values: Record<string, unknown>) => Promise<void>>();

// Mock the DB + scrubber before importing lens so the dynamic wiring hits
// our fakes rather than touching Neon.
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        await insertSpy(values);
      },
    }),
  },
  aiUsageLogs: Symbol("aiUsageLogs"),
}));

vi.mock("../pricing", () => ({
  computeCost: () => 0.00001,
}));

vi.mock("../spend-guard", () => ({
  reconcilePlatformSpend: vi.fn(async () => {}),
}));

vi.mock("../pii-scrub", () => ({
  scrub: (v: string | undefined) => v ?? null,
}));

const baseParams = {
  userId: "00000000-0000-0000-0000-000000000001",
  feature: "remediation" as const,
  provider: "openai",
  model: "gpt-5.4-mini",
  inputTokens: 100,
  outputTokens: 50,
};

describe("lens telemetry passthrough", () => {
  beforeEach(() => {
    insertSpy.mockReset();
  });

  it("forwards every Fase 1 field to the insert payload", async () => {
    const { logAICall } = await import("../lens");

    logAICall({
      ...baseParams,
      turnNumber: 3,
      ttftMs: 450,
      phase: "explore",
      modelTier: "mini",
      toolName: "read_file",
      toolExecMs: 22,
      reasoningTokens: 1200,
    });

    // logAICall is fire-and-forget — wait a tick for the promise chain.
    await new Promise((r) => setImmediate(r));

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const values = insertSpy.mock.calls[0]![0];

    expect(values.turnNumber).toBe(3);
    expect(values.ttftMs).toBe(450);
    expect(values.phase).toBe("explore");
    expect(values.modelTier).toBe("mini");
    expect(values.toolName).toBe("read_file");
    expect(values.toolExecMs).toBe(22);
    expect(values.reasoningTokens).toBe(1200);
  });

  it("defaults non-derivable telemetry fields to null when the caller omits them", async () => {
    const { logAICall } = await import("../lens");

    logAICall(baseParams);
    await new Promise((r) => setImmediate(r));

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const values = insertSpy.mock.calls[0]![0];

    expect(values.turnNumber).toBeNull();
    expect(values.ttftMs).toBeNull();
    expect(values.phase).toBeNull();
    // modelTier is auto-derived from baseParams.model ('gpt-5.4-mini' → 'mini')
    // — the Fase 3.5 hotfix moved derivation into runLog so callers don't
    // have to keep the mapping in sync. Pass modelTier:null explicitly to
    // force unclassified (covered by a separate test below).
    expect(values.modelTier).toBe("mini");
    expect(values.toolName).toBeNull();
    expect(values.toolExecMs).toBeNull();
    expect(values.reasoningTokens).toBeNull();
  });

  it("allows partial population: phase set, tool fields unset", async () => {
    const { logAICall } = await import("../lens");

    logAICall({ ...baseParams, phase: "fix", modelTier: "reasoning" });
    await new Promise((r) => setImmediate(r));

    const values = insertSpy.mock.calls[0]![0];
    expect(values.phase).toBe("fix");
    expect(values.modelTier).toBe("reasoning");
    expect(values.toolName).toBeNull();
    expect(values.toolExecMs).toBeNull();
    expect(values.turnNumber).toBeNull();
  });

  // ── Fase 3.5 hotfix: auto-derived modelTier ───────────────────────────────

  it("derives modelTier from model name when caller omits it (gpt-5-nano → nano)", async () => {
    const { logAICall } = await import("../lens");
    logAICall({ ...baseParams, model: "gpt-5-nano", phase: "classify" });
    await new Promise((r) => setImmediate(r));
    expect(insertSpy.mock.calls[0]![0].modelTier).toBe("nano");
  });

  it("derives mini for gpt-5.4-mini even though it also contains '5.4'", async () => {
    const { logAICall } = await import("../lens");
    logAICall({ ...baseParams, model: "gpt-5.4-mini", phase: "explore" });
    await new Promise((r) => setImmediate(r));
    expect(insertSpy.mock.calls[0]![0].modelTier).toBe("mini");
  });

  it("derives standard for gpt-5.4 (flagship)", async () => {
    const { logAICall } = await import("../lens");
    logAICall({ ...baseParams, model: "gpt-5.4", phase: "fix" });
    await new Promise((r) => setImmediate(r));
    expect(insertSpy.mock.calls[0]![0].modelTier).toBe("standard");
  });

  it("derives reasoning for opus models", async () => {
    const { logAICall } = await import("../lens");
    logAICall({ ...baseParams, model: "claude-opus-4-7", phase: "fix" });
    await new Promise((r) => setImmediate(r));
    expect(insertSpy.mock.calls[0]![0].modelTier).toBe("reasoning");
  });

  it("respects explicit modelTier=null (caller forces unclassified)", async () => {
    const { logAICall } = await import("../lens");
    logAICall({ ...baseParams, model: "gpt-5.4", modelTier: null });
    await new Promise((r) => setImmediate(r));
    expect(insertSpy.mock.calls[0]![0].modelTier).toBeNull();
  });

  it("respects explicit modelTier=mini even when model name says 'standard'", async () => {
    const { logAICall } = await import("../lens");
    logAICall({ ...baseParams, model: "gpt-5.4", modelTier: "mini" });
    await new Promise((r) => setImmediate(r));
    expect(insertSpy.mock.calls[0]![0].modelTier).toBe("mini");
  });
});

describe("deriveModelTier", () => {
  it("classifies the full Fase 3.5 catalog correctly", async () => {
    const { deriveModelTier } = await import("../lens");
    // nano
    expect(deriveModelTier("gpt-5-nano")).toBe("nano");
    expect(deriveModelTier("anything-nano-foo")).toBe("nano");
    // mini (includes haiku)
    expect(deriveModelTier("gpt-4o-mini")).toBe("mini");
    expect(deriveModelTier("gpt-5.4-mini")).toBe("mini");
    expect(deriveModelTier("claude-haiku-4-5-20251001")).toBe("mini");
    // standard
    expect(deriveModelTier("gpt-5.4")).toBe("standard");
    expect(deriveModelTier("claude-sonnet-4-6")).toBe("standard");
    expect(deriveModelTier("gpt-4o")).toBe("standard");
    // reasoning
    expect(deriveModelTier("claude-opus-4-7")).toBe("reasoning");
    // unknown → null (clean), not "unknown"
    expect(deriveModelTier("gemini-1.5-flash")).toBeNull();
    expect(deriveModelTier("llama3-70b")).toBeNull();
    // empty/null/undefined → null
    expect(deriveModelTier(null)).toBeNull();
    expect(deriveModelTier(undefined)).toBeNull();
    expect(deriveModelTier("")).toBeNull();
  });

  it("is case-insensitive on the canonical substrings", async () => {
    const { deriveModelTier } = await import("../lens");
    expect(deriveModelTier("GPT-5-NANO")).toBe("nano");
    expect(deriveModelTier("Claude-Haiku")).toBe("mini");
    expect(deriveModelTier("Claude-OPUS")).toBe("reasoning");
  });
});
