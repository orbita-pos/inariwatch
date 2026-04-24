import { describe, it, expect, beforeEach, vi } from "vitest";

const callAIMock = vi.fn();
vi.mock("../client", () => ({
  callAI: (...args: unknown[]) => callAIMock(...args),
}));

vi.mock("../models", () => ({
  resolveModelForPhase: () => "gpt-5-nano",
}));

import { runTier1 } from "../tier-1-handler";
import type { RouterFeatures } from "../tier-router";

const baseSession = {
  id: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  alertId: "33333333-3333-3333-3333-333333333333",
  userId: "44444444-4444-4444-4444-444444444444",
};

const baseFeatures = (cat: RouterFeatures["errorCategory"]): RouterFeatures => ({
  errorCategory: cat,
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
});

const baseCtx = {
  diagnosis: "x.foo is undefined when y is null",
  fileContents: [{ path: "src/x.ts", content: "function foo(y) { return y.foo; }" }],
  alertTitle: "TypeError: cannot read foo of null",
  alertBody: "TypeError: cannot read foo of null\n    at foo (src/x.ts:2:18)",
};

beforeEach(() => {
  callAIMock.mockReset();
  process.env.PLATFORM_AI_KEY = "test-key";
});

describe("runTier1 — template gating", () => {
  it("returns no_template for unsupported category", async () => {
    const r = await runTier1(baseSession, baseFeatures("Network"), baseCtx);
    expect(r).toEqual({ ok: false, skipped: "no_template" });
    expect(callAIMock).not.toHaveBeenCalled();
  });

  it("returns no_template when no source files were provided", async () => {
    const r = await runTier1(baseSession, baseFeatures("TypeError"), { ...baseCtx, fileContents: [] });
    expect(r).toEqual({ ok: false, skipped: "no_template" });
    expect(callAIMock).not.toHaveBeenCalled();
  });
});

describe("runTier1 — supported categories invoke the model", () => {
  it.each(["TypeError", "ReferenceError", "Runtime"] as const)("invokes model for %s", async (cat) => {
    callAIMock.mockResolvedValueOnce(
      JSON.stringify({ explanation: "guard added", files: [{ path: "src/x.ts", content: "function foo(y) { return y?.foo; }" }] }),
    );
    const r = await runTier1(baseSession, baseFeatures(cat), baseCtx);
    expect(r.ok).toBe(true);
    expect(callAIMock).toHaveBeenCalledOnce();
  });
});

describe("runTier1 — output parsing", () => {
  it("returns malformed_output when model returns garbage", async () => {
    callAIMock.mockResolvedValueOnce("not json at all");
    const r = await runTier1(baseSession, baseFeatures("TypeError"), baseCtx);
    expect(r).toEqual({ ok: false, skipped: "malformed_output" });
  });

  it("returns empty_fix when model returns no files", async () => {
    callAIMock.mockResolvedValueOnce(JSON.stringify({ explanation: "abstain", files: [] }));
    const r = await runTier1(baseSession, baseFeatures("TypeError"), baseCtx);
    expect(r).toEqual({ ok: false, skipped: "empty_fix" });
  });

  it("strips markdown fences around JSON", async () => {
    callAIMock.mockResolvedValueOnce(
      "```json\n" + JSON.stringify({ explanation: "fix", files: [{ path: "src/x.ts", content: "ok" }] }) + "\n```",
    );
    const r = await runTier1(baseSession, baseFeatures("TypeError"), baseCtx);
    expect(r.ok).toBe(true);
  });

  it("returns model_error when callAI throws", async () => {
    callAIMock.mockRejectedValueOnce(new Error("upstream timeout"));
    const r = await runTier1(baseSession, baseFeatures("TypeError"), baseCtx);
    expect(r).toEqual({ ok: false, skipped: "model_error" });
  });
});

describe("runTier1 — environment", () => {
  it("returns no_api_key when neither PLATFORM_AI_KEY nor OPENAI_API_KEY is set", async () => {
    delete process.env.PLATFORM_AI_KEY;
    delete process.env.OPENAI_API_KEY;
    const r = await runTier1(baseSession, baseFeatures("TypeError"), baseCtx);
    expect(r).toEqual({ ok: false, skipped: "no_api_key" });
  });
});
