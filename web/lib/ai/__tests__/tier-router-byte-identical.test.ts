/**
 * Snapshot test — enforces the Fase 6 acceptance criterion:
 *
 *     With TIER_ROUTER_MODE unset (the production default), routeTier
 *     returns null WITHOUT issuing a single DB query, a single LLM call,
 *     or a single session update. The pipeline is byte-identical to
 *     pre-Fase-6 behavior from the moment the flag is off.
 *
 * If this test regresses, shadow is leaking into 'off' mode and the
 * promotion playbook's "rollback = flip flag" contract is broken.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMock = vi.fn();
const updateSetMock = vi.fn();
const insertValuesMock = vi.fn();

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

import { routeTier } from "../tier-router";

beforeEach(() => {
  executeMock.mockReset();
  updateSetMock.mockReset();
  insertValuesMock.mockReset();
  callAIMock.mockReset();
  lookupPatternMock.mockReset();
});

describe("byte-identical: TIER_ROUTER_MODE='off'", () => {
  it("zero DB queries when env unset", async () => {
    delete process.env.TIER_ROUTER_MODE;
    await routeTier("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    expect(executeMock).toHaveBeenCalledTimes(0);
  });

  it("zero LLM calls when env unset", async () => {
    delete process.env.TIER_ROUTER_MODE;
    await routeTier("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    expect(callAIMock).toHaveBeenCalledTimes(0);
  });

  it("zero session updates when env unset", async () => {
    delete process.env.TIER_ROUTER_MODE;
    await routeTier("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    expect(updateSetMock).toHaveBeenCalledTimes(0);
  });

  it("zero ai_usage_logs inserts when env unset", async () => {
    delete process.env.TIER_ROUTER_MODE;
    await routeTier("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    expect(insertValuesMock).toHaveBeenCalledTimes(0);
  });

  it("zero pattern-memory lookups when env unset", async () => {
    delete process.env.TIER_ROUTER_MODE;
    await routeTier("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    expect(lookupPatternMock).toHaveBeenCalledTimes(0);
  });

  it("returns null when env unset", async () => {
    delete process.env.TIER_ROUTER_MODE;
    const r = await routeTier("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    expect(r).toBeNull();
  });

  it("treats unknown mode values as 'off'", async () => {
    process.env.TIER_ROUTER_MODE = "enabled";
    const r = await routeTier("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
    expect(r).toBeNull();
    expect(executeMock).toHaveBeenCalledTimes(0);
    delete process.env.TIER_ROUTER_MODE;
  });
});
