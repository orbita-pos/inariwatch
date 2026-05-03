// Phase 2.3 — verifies the indexer pipeline now routes through the
// multi-extractor when no legacy `extractor` seam is set, and that the
// per-language seams (`tsExtractor` / `pyExtractor` / `detectLanguages`)
// are honored end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runIndexerV2 } from "../indexer";

vi.mock("../persist", () => ({
  persistRepoExtraction: vi.fn(async (extraction: { symbols: unknown[]; references: unknown[]; typeFacts: unknown[]; imports: unknown[] }) => ({
    symbolsInserted: extraction.symbols.length,
    referencesInserted: extraction.references.length,
    typeFactsInserted: extraction.typeFacts.length,
    importsInserted: extraction.imports.length,
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

const persistMock = vi.mocked(persistRepoExtraction);

beforeEach(() => {
  persistMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sym = (lang: string, fqn: string) => ({
  fqn,
  kind: "function" as const,
  name: fqn.split("::").pop() ?? fqn,
  filePath: fqn.split("::")[0] ?? "src/a.ts",
  startLine: 1,
  endLine: 2,
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
  language: lang,
  astHash: "h",
});

const tsExt = vi.fn(async () => ({
  repoPath: "/tmp/repo",
  symbols: [sym("typescript", "src/a.ts::ts_fn")],
  references: [],
  typeFacts: [],
  imports: [],
  diagnostics: [],
  filesProcessed: 1,
  durationMs: 5,
}));

const pyExt = vi.fn(async () => ({
  repoPath: "/tmp/repo",
  symbols: [sym("python", "app/a.py::py_fn")],
  references: [],
  typeFacts: [],
  imports: [],
  diagnostics: [],
  filesProcessed: 1,
  durationMs: 8,
}));

beforeEach(() => {
  tsExt.mockClear();
  pyExt.mockClear();
});

describe("runIndexerV2 — multi-language", () => {
  it("invokes both extractors for a mixed-lang full re-index", async () => {
    const result = await runIndexerV2({
      repoId: "repo-1",
      repoPath: "/tmp/repo",
      tsExtractor: tsExt,
      pyExtractor: pyExt,
      detectLanguages: () => new Set(["typescript", "python"]),
    });

    expect(tsExt).toHaveBeenCalledTimes(1);
    expect(pyExt).toHaveBeenCalledTimes(1);
    expect(result.symbolsInserted).toBe(2);
    expect(result.filesProcessed).toBe(2);
    // Persist receives the merged extraction.
    const persistedExtraction = persistMock.mock.calls[0]?.[0];
    expect(persistedExtraction?.symbols.map((s) => s.language).sort()).toEqual([
      "python",
      "typescript",
    ]);
  });

  it("buckets changed files per extractor in incremental mode", async () => {
    await runIndexerV2({
      repoId: "repo-2",
      repoPath: "/tmp/repo",
      changedFiles: ["src/a.ts", "app/x.py"],
      tsExtractor: tsExt,
      pyExtractor: pyExt,
    });

    expect(tsExt.mock.calls[0]?.[0].changedFiles).toEqual(["src/a.ts"]);
    expect(pyExt.mock.calls[0]?.[0].changedFiles).toEqual(["app/x.py"]);
  });

  it("legacy `extractor` seam still bypasses the multi-extractor", async () => {
    const legacyStub = vi.fn(async () => ({
      repoPath: "/tmp/repo",
      symbols: [sym("typescript", "src/a.ts::legacy")],
      references: [],
      typeFacts: [],
      imports: [],
      diagnostics: [],
      filesProcessed: 1,
      durationMs: 1,
    }));

    await runIndexerV2({
      repoId: "repo-3",
      repoPath: "/tmp/repo",
      extractor: legacyStub,
      tsExtractor: tsExt, // ignored when `extractor` is set
      pyExtractor: pyExt,
    });

    expect(legacyStub).toHaveBeenCalledTimes(1);
    expect(tsExt).not.toHaveBeenCalled();
    expect(pyExt).not.toHaveBeenCalled();
  });

  it("only the present language's extractor runs on a single-lang full re-index", async () => {
    await runIndexerV2({
      repoId: "repo-4",
      repoPath: "/tmp/repo",
      tsExtractor: tsExt,
      pyExtractor: pyExt,
      detectLanguages: () => new Set(["typescript"]),
    });

    expect(tsExt).toHaveBeenCalledTimes(1);
    expect(pyExt).not.toHaveBeenCalled();
  });
});
