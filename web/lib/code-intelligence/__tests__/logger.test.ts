/**
 * Code Intelligence v2 — Phase 0.4
 * Unit tests for the structured logger. Validates JSON shape, sanitization,
 * severity routing, and tag invariants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logCodeIntelEvent } from "../logger";

describe("logCodeIntelEvent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function captureLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0];
    expect(typeof arg).toBe("string");
    return JSON.parse(arg as string) as Record<string, unknown>;
  }

  it("emits info events on console.log", () => {
    logCodeIntelEvent({
      event: "embedding.fallback",
      severity: "info",
      provider: "voyage",
    });
    const line = captureLine(logSpy);
    expect(line.module).toBe("code-intelligence");
    expect(line.phase).toBe("v1");
    expect(line.event).toBe("embedding.fallback");
    expect(line.severity).toBe("info");
    expect(line.provider).toBe("voyage");
    expect(typeof line.timestamp).toBe("string");
  });

  it("emits warn events on console.warn", () => {
    logCodeIntelEvent({
      event: "search.rerank_failed",
      severity: "warn",
      detail: { candidateCount: 12 },
    });
    const line = captureLine(warnSpy);
    expect(line.severity).toBe("warn");
    expect(line.detail).toEqual({ candidateCount: 12 });
  });

  it("emits error events on console.error", () => {
    logCodeIntelEvent({
      event: "indexer.embedding_batch_failed",
      severity: "error",
      error: new Error("Voyage 503"),
    });
    const line = captureLine(errorSpy);
    expect(line.severity).toBe("error");
    expect(line.errorMessage).toBe("Voyage 503");
  });

  it("redacts API keys and bearer tokens from error messages", () => {
    logCodeIntelEvent({
      event: "embedding.failure",
      severity: "warn",
      error: new Error(
        "401 Bearer pa-abcdefghij1234567890 sk-livekey1234567890 ghp_realtokenabcd1234"
      ),
    });
    const line = captureLine(warnSpy);
    expect(line.errorMessage).not.toContain("pa-abcdefghij");
    expect(line.errorMessage).not.toContain("sk-livekey");
    expect(line.errorMessage).not.toContain("ghp_realtoken");
    expect(line.errorMessage).toContain("[REDACTED]");
  });

  it("omits empty fields from output", () => {
    logCodeIntelEvent({
      event: "embedding.failure",
      severity: "warn",
    });
    const line = captureLine(warnSpy);
    expect(line).not.toHaveProperty("repoId");
    expect(line).not.toHaveProperty("projectId");
    expect(line).not.toHaveProperty("provider");
    expect(line).not.toHaveProperty("detail");
    expect(line).not.toHaveProperty("errorMessage");
  });

  it("includes scoped identifiers when provided", () => {
    logCodeIntelEvent({
      event: "indexer.docstring_batch_failed",
      severity: "warn",
      repoId: "repo-1",
      projectId: "proj-1",
      chunkId: "chunk-1",
    });
    const line = captureLine(warnSpy);
    expect(line.repoId).toBe("repo-1");
    expect(line.projectId).toBe("proj-1");
    expect(line.chunkId).toBe("chunk-1");
  });
});
