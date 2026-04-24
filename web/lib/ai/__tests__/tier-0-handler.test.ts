import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMock = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

const getFileContentMock = vi.fn();
vi.mock("@/lib/services/github-api", () => ({
  getFileContent: (...args: unknown[]) => getFileContentMock(...args),
}));

import { runTier0 } from "../tier-0-handler";
import type { PatternMatch } from "../pattern-memory";

const rowsResult = <T>(rows: T[]) => Object.assign([...rows], { rows });

const baseSession = {
  id: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  alertId: "33333333-3333-3333-3333-333333333333",
  repo: "owner/repo",
  baseBranch: "main",
};

const baseCtx = {
  githubToken: "ghp_test",
  owner: "owner",
  repo: "repo",
  baseBranch: "main",
  fingerprint: "fp_abc123",
};

const passingMatch: PatternMatch = {
  patternId: "pat_1",
  score: 0.95,
  fixStrategy: "null-check",
  filesTouched: ["src/x.ts"],
  successCount: 5,
  confidence: 0.9,
  postMergeHealth: 0.97,
  fromCommunity: false,
};

beforeEach(() => {
  executeMock.mockReset();
  getFileContentMock.mockReset();
});

describe("runTier0 — gate enforcement", () => {
  it("returns gate_failed when score is below threshold", async () => {
    const r = await runTier0(baseSession, { ...passingMatch, score: 0.8 }, baseCtx);
    expect(r).toEqual({ ok: false, skipped: "gate_failed" });
  });

  it("returns gate_failed when success_count is below threshold", async () => {
    const r = await runTier0(baseSession, { ...passingMatch, successCount: 1 }, baseCtx);
    expect(r).toEqual({ ok: false, skipped: "gate_failed" });
  });

  it("returns gate_failed when post-merge health is below threshold", async () => {
    const r = await runTier0(baseSession, { ...passingMatch, postMergeHealth: 0.7 }, baseCtx);
    expect(r).toEqual({ ok: false, skipped: "gate_failed" });
  });
});

describe("runTier0 — donor session lookup", () => {
  it("returns no_cached_diff when no donor session exists", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([]));
    const r = await runTier0(baseSession, passingMatch, baseCtx);
    expect(r).toEqual({ ok: false, skipped: "no_cached_diff" });
  });

  it("returns no_cached_diff when donor file_changes is empty", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ id: "donor1", file_changes: [] }]));
    const r = await runTier0(baseSession, passingMatch, baseCtx);
    expect(r).toEqual({ ok: false, skipped: "no_cached_diff" });
  });

  it("returns no_cached_diff when file_changes is malformed (no path/content)", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ id: "donor1", file_changes: [{ wrong: "shape" }] }]));
    const r = await runTier0(baseSession, passingMatch, baseCtx);
    expect(r).toEqual({ ok: false, skipped: "no_cached_diff" });
  });
});

describe("runTier0 — apply detection", () => {
  it("returns apply_failed when current file content already matches the cached patch (no-op)", async () => {
    executeMock.mockResolvedValueOnce(
      rowsResult([{ id: "donor1", file_changes: [{ path: "src/x.ts", content: "fixed content" }] }]),
    );
    getFileContentMock.mockResolvedValueOnce("fixed content");

    const r = await runTier0(baseSession, passingMatch, baseCtx);
    expect(r).toEqual({ ok: false, skipped: "apply_failed" });
  });

  it("returns ok when current content differs from cached patch", async () => {
    executeMock.mockResolvedValueOnce(
      rowsResult([{ id: "donor1", file_changes: [{ path: "src/x.ts", content: "fixed content" }] }]),
    );
    getFileContentMock.mockResolvedValueOnce("buggy content");

    const r = await runTier0(baseSession, passingMatch, baseCtx);
    expect(r).toEqual({
      ok: true,
      donorSessionId: "donor1",
      fileChanges: [{ path: "src/x.ts", content: "fixed content" }],
    });
  });

  it("returns ok when one of multiple files differs (not all already match)", async () => {
    executeMock.mockResolvedValueOnce(
      rowsResult([
        {
          id: "donor1",
          file_changes: [
            { path: "src/x.ts", content: "fixed content x" },
            { path: "src/y.ts", content: "fixed content y" },
          ],
        },
      ]),
    );
    getFileContentMock.mockResolvedValueOnce("fixed content x").mockResolvedValueOnce("buggy y");

    const r = await runTier0(baseSession, passingMatch, baseCtx);
    expect(r.ok).toBe(true);
  });
});
