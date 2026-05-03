// Phase 2.3 — multi-extractor dispatcher tests.
//
// Stubs both per-language extractors so the test stays hermetic — no real
// pyright spawn, no on-disk fixtures.

import { describe, expect, it, vi } from "vitest";

import { runMultiExtractor } from "../multi-extractor";

const tsSymbol = (fqn: string) => ({
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
  language: "typescript",
  astHash: "h1",
});

const pySymbol = (fqn: string) => ({
  fqn,
  kind: "function" as const,
  name: fqn.split("::").pop() ?? fqn,
  filePath: fqn.split("::")[0] ?? "app/a.py",
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
  language: "python",
  astHash: "h2",
});

const TS_OUTPUT = {
  repoPath: "/tmp/repo",
  symbols: [tsSymbol("src/a.ts::ts_fn")],
  references: [],
  typeFacts: [],
  imports: [],
  diagnostics: [],
  filesProcessed: 1,
  durationMs: 5,
};

const PY_OUTPUT = {
  repoPath: "/tmp/repo",
  symbols: [pySymbol("app/a.py::py_fn")],
  references: [],
  typeFacts: [],
  imports: [],
  diagnostics: ["py: ok"],
  filesProcessed: 1,
  durationMs: 8,
};

describe("runMultiExtractor — full re-index", () => {
  it("invokes both extractors when both languages present", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);
    const detect = () => new Set<"typescript" | "python">(["typescript", "python"]);

    const out = await runMultiExtractor({
      repoPath: "/tmp/repo",
      tsExtractor: tsStub,
      pyExtractor: pyStub,
      detectLanguages: detect,
    });

    expect(tsStub).toHaveBeenCalledTimes(1);
    expect(pyStub).toHaveBeenCalledTimes(1);
    expect(out.symbols).toHaveLength(2);
    expect(out.symbols.map((s) => s.language).sort()).toEqual(["python", "typescript"]);
    expect(out.filesProcessed).toBe(2);
    expect(out.diagnostics).toContain("py: ok");
  });

  it("skips py extractor when no .py files present", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);
    const detect = () => new Set<"typescript" | "python">(["typescript"]);

    const out = await runMultiExtractor({
      repoPath: "/tmp/repo",
      tsExtractor: tsStub,
      pyExtractor: pyStub,
      detectLanguages: detect,
    });

    expect(tsStub).toHaveBeenCalledTimes(1);
    expect(pyStub).not.toHaveBeenCalled();
    expect(out.symbols).toHaveLength(1);
    expect(out.symbols[0]?.language).toBe("typescript");
  });

  it("skips ts extractor when no .ts files present", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);
    const detect = () => new Set<"typescript" | "python">(["python"]);

    const out = await runMultiExtractor({
      repoPath: "/tmp/repo",
      tsExtractor: tsStub,
      pyExtractor: pyStub,
      detectLanguages: detect,
    });

    expect(tsStub).not.toHaveBeenCalled();
    expect(pyStub).toHaveBeenCalledTimes(1);
    expect(out.symbols[0]?.language).toBe("python");
  });

  it("returns empty output when no supported language present", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);
    const detect = () => new Set<"typescript" | "python">();

    const out = await runMultiExtractor({
      repoPath: "/tmp/repo",
      tsExtractor: tsStub,
      pyExtractor: pyStub,
      detectLanguages: detect,
    });

    expect(tsStub).not.toHaveBeenCalled();
    expect(pyStub).not.toHaveBeenCalled();
    expect(out.symbols).toEqual([]);
    expect(out.filesProcessed).toBe(0);
  });

  it("forwards tsconfigPath to the TS extractor only", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);
    const detect = () => new Set<"typescript" | "python">(["typescript", "python"]);

    await runMultiExtractor({
      repoPath: "/tmp/repo",
      tsconfigPath: "tsconfig.build.json",
      tsExtractor: tsStub,
      pyExtractor: pyStub,
      detectLanguages: detect,
    });

    expect(tsStub.mock.calls[0]?.[0]).toMatchObject({
      repoPath: "/tmp/repo",
      tsconfigPath: "tsconfig.build.json",
    });
    expect(pyStub.mock.calls[0]?.[0]).toEqual({ repoPath: "/tmp/repo" });
    expect((pyStub.mock.calls[0]?.[0] as Record<string, unknown>).tsconfigPath).toBeUndefined();
  });
});

describe("runMultiExtractor — incremental", () => {
  it("buckets changed files by language and only invokes the right extractor", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);
    const detect = vi.fn(() => new Set<"typescript" | "python">());

    await runMultiExtractor({
      repoPath: "/tmp/repo",
      changedFiles: ["src/foo.ts", "src/bar.tsx", "app/baz.py", "README.md"],
      tsExtractor: tsStub,
      pyExtractor: pyStub,
      detectLanguages: detect,
    });

    // detectLanguages must NOT be called for incremental mode (we use buckets
    // instead).
    expect(detect).not.toHaveBeenCalled();
    expect(tsStub.mock.calls[0]?.[0].changedFiles).toEqual([
      "src/foo.ts",
      "src/bar.tsx",
    ]);
    expect(pyStub.mock.calls[0]?.[0].changedFiles).toEqual(["app/baz.py"]);
  });

  it("warns about unknown changed files via diagnostics", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);

    const out = await runMultiExtractor({
      repoPath: "/tmp/repo",
      changedFiles: ["src/a.ts", "README.md", "go/main.go"],
      tsExtractor: tsStub,
      pyExtractor: pyStub,
    });

    expect(out.diagnostics.some((d) => d.includes("unknown language"))).toBe(true);
    expect(out.diagnostics.some((d) => d.includes("README.md"))).toBe(true);
  });

  it("skips both extractors when all changed files are unknown", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);

    const out = await runMultiExtractor({
      repoPath: "/tmp/repo",
      changedFiles: ["README.md", "package.json"],
      tsExtractor: tsStub,
      pyExtractor: pyStub,
    });

    expect(tsStub).not.toHaveBeenCalled();
    expect(pyStub).not.toHaveBeenCalled();
    expect(out.symbols).toEqual([]);
    // Diagnostics should still mention what we skipped.
    expect(out.diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  it("only invokes ts extractor when only ts files changed", async () => {
    const tsStub = vi.fn(async () => TS_OUTPUT);
    const pyStub = vi.fn(async () => PY_OUTPUT);

    await runMultiExtractor({
      repoPath: "/tmp/repo",
      changedFiles: ["src/a.ts"],
      tsExtractor: tsStub,
      pyExtractor: pyStub,
    });

    expect(tsStub).toHaveBeenCalledTimes(1);
    expect(pyStub).not.toHaveBeenCalled();
  });
});

describe("runMultiExtractor — output merging", () => {
  it("concatenates symbols/refs/typeFacts/imports + sums filesProcessed", async () => {
    const tsStub = vi.fn(async () => ({
      ...TS_OUTPUT,
      symbols: [tsSymbol("src/a.ts::a"), tsSymbol("src/b.ts::b")],
      references: [
        {
          sourceFqn: null,
          sourceKind: null,
          targetFqn: "src/a.ts::a",
          targetKind: "function",
          filePath: "src/b.ts",
          line: 5,
          col: 0,
          kind: "call" as const,
        },
      ],
      filesProcessed: 2,
    }));
    const pyStub = vi.fn(async () => ({
      ...PY_OUTPUT,
      symbols: [pySymbol("app/x.py::x")],
      typeFacts: [{
        symbolFqn: "app/x.py::x",
        symbolKind: "function" as const,
        paramTypes: null,
        returnType: "int",
        genericParams: null,
        throws: null,
        sideEffects: null,
      }],
      filesProcessed: 1,
    }));
    const detect = () => new Set<"typescript" | "python">(["typescript", "python"]);

    const out = await runMultiExtractor({
      repoPath: "/tmp/repo",
      tsExtractor: tsStub,
      pyExtractor: pyStub,
      detectLanguages: detect,
    });

    expect(out.symbols).toHaveLength(3);
    expect(out.references).toHaveLength(1);
    expect(out.typeFacts).toHaveLength(1);
    expect(out.filesProcessed).toBe(3);
  });
});
