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

  it("defaults every telemetry field to null when the caller omits it", async () => {
    const { logAICall } = await import("../lens");

    logAICall(baseParams);
    await new Promise((r) => setImmediate(r));

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const values = insertSpy.mock.calls[0]![0];

    expect(values.turnNumber).toBeNull();
    expect(values.ttftMs).toBeNull();
    expect(values.phase).toBeNull();
    expect(values.modelTier).toBeNull();
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
});
