import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { runIndexerV2 } from "../indexer";

// We mock the persist + service-layer collaborators so the test stays
// hermetic — the real DB never gets touched. Phase 1.5 wires in an
// integration test that runs against the migration-applied schema.

vi.mock("../persist", () => ({
  persistRepoExtraction: vi.fn(async () => ({
    symbolsInserted: 3,
    referencesInserted: 5,
    typeFactsInserted: 2,
    importsInserted: 1,
  })),
}));

vi.mock("@/lib/services/code-intelligence.service", () => ({
  updateRepoIndexingStatus: vi.fn(async () => undefined),
  markRepoIndexed: vi.fn(async () => undefined),
}));

vi.mock("@/lib/code-intelligence/logger", () => ({
  logCodeIntelEvent: vi.fn(),
}));

import { persistRepoExtraction } from "../persist";
import {
  markRepoIndexed,
  updateRepoIndexingStatus,
} from "@/lib/services/code-intelligence.service";

const persistMock = vi.mocked(persistRepoExtraction);
const updateStatusMock = vi.mocked(updateRepoIndexingStatus);
const markReadyMock = vi.mocked(markRepoIndexed);

beforeEach(() => {
  persistMock.mockClear();
  updateStatusMock.mockClear();
  markReadyMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleExtraction = {
  repoPath: "/tmp/repo",
  symbols: [
    {
      fqn: "src/a.ts::foo",
      kind: "function" as const,
      name: "foo",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 3,
      startCol: 0,
      endCol: 0,
      signature: null,
      returnType: null,
      isAsync: false,
      isExported: true,
      isStatic: false,
      isAbstract: false,
      visibility: null,
      docComment: null,
      parentFqn: null,
      parentKind: null,
      language: "typescript",
      astHash: "h1",
    },
  ],
  references: [],
  typeFacts: [],
  imports: [],
  diagnostics: [],
  filesProcessed: 1,
  durationMs: 12,
};

describe("runIndexerV2", () => {
  it("happy path: marks indexing → persists → marks ready", async () => {
    const events: string[] = [];
    const out = await runIndexerV2({
      repoId: "repo-1",
      repoPath: "/tmp/repo",
      commit: "abc123",
      extractor: async () => sampleExtraction,
      onProgress: (e) => events.push(e.phase),
    });

    expect(updateStatusMock).toHaveBeenCalledTimes(1);
    expect(updateStatusMock).toHaveBeenCalledWith({
      repoId: "repo-1",
      status: "indexing",
      errorMessage: null,
    });
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock.mock.calls[0]?.[0]).toBe(sampleExtraction);
    expect(persistMock.mock.calls[0]?.[1]).toMatchObject({
      repoId: "repo-1",
      fullReindex: true,
      clearedFilePaths: undefined,
    });
    expect(markReadyMock).toHaveBeenCalledTimes(1);
    expect(markReadyMock).toHaveBeenCalledWith({
      repoId: "repo-1",
      commit: "abc123",
      totalSymbols: 3,
    });
    expect(events).toEqual(["extracting", "persisting", "done"]);
    expect(out.symbolsInserted).toBe(3);
    expect(out.filesProcessed).toBe(1);
  });

  it("incremental path: forwards changedFiles to persist as clearedFilePaths", async () => {
    await runIndexerV2({
      repoId: "repo-2",
      repoPath: "/tmp/repo",
      changedFiles: ["src/a.ts", "src/b.ts"],
      extractor: async () => sampleExtraction,
    });

    expect(persistMock.mock.calls[0]?.[1]).toMatchObject({
      repoId: "repo-2",
      fullReindex: false,
      clearedFilePaths: ["src/a.ts", "src/b.ts"],
    });
  });

  it("extractor failure: marks failed and rethrows", async () => {
    const events: string[] = [];
    await expect(
      runIndexerV2({
        repoId: "repo-3",
        repoPath: "/tmp/repo",
        extractor: async () => {
          throw new Error("boom");
        },
        onProgress: (e) => events.push(`${e.phase}:${e.message ?? ""}`),
      }),
    ).rejects.toThrow("boom");

    expect(updateStatusMock).toHaveBeenCalledTimes(2);
    expect(updateStatusMock.mock.calls[0]?.[0]).toMatchObject({ status: "indexing" });
    expect(updateStatusMock.mock.calls[1]?.[0]).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("boom"),
    });
    expect(markReadyMock).not.toHaveBeenCalled();
    expect(events.some((e) => e.startsWith("error:"))).toBe(true);
  });

  it("persist failure: marks failed and rethrows", async () => {
    persistMock.mockRejectedValueOnce(new Error("db down"));

    await expect(
      runIndexerV2({
        repoId: "repo-4",
        repoPath: "/tmp/repo",
        extractor: async () => sampleExtraction,
      }),
    ).rejects.toThrow("db down");

    expect(updateStatusMock).toHaveBeenCalledTimes(2);
    expect(updateStatusMock.mock.calls[1]?.[0]).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("db down"),
    });
    expect(markReadyMock).not.toHaveBeenCalled();
  });

  it("returns extractor diagnostics in result", async () => {
    const out = await runIndexerV2({
      repoId: "repo-5",
      repoPath: "/tmp/repo",
      extractor: async () => ({
        ...sampleExtraction,
        diagnostics: ["warn: alias for foo not resolved"],
      }),
    });
    expect(out.diagnostics).toEqual(["warn: alias for foo not resolved"]);
  });
});
