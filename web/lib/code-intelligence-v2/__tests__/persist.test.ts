import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ExtractorOutput } from "@inariwatch/code-intel-extractor-ts";

// Drizzle's `db` builder chains many methods; we stub each chain so the
// persist module exercises its full happy-path SQL without a real Postgres.
// Only the surface that persist.ts reaches is implemented; anything else
// throws so unintended access surfaces immediately.

interface InsertCapture {
  table: string;
  values: unknown[];
  onConflict?: { target: unknown; set: unknown };
}

const inserts: InsertCapture[] = [];
const updates: Array<{ table: string; set: Record<string, unknown>; where: unknown }> = [];
const deletes: Array<{ table: string; where: unknown }> = [];

function makeInsertChain(table: string, returnedRows: Array<Record<string, unknown>>): unknown {
  return {
    values(values: unknown[]) {
      const cap: InsertCapture = { table, values };
      inserts.push(cap);
      return {
        onConflictDoUpdate({ target, set }: { target: unknown; set: unknown }) {
          cap.onConflict = { target, set };
          return {
            returning() {
              return Promise.resolve(returnedRows);
            },
          };
        },
        // Plain insert (no conflict) chain.
        then(resolve: (v: unknown) => void) {
          resolve(undefined);
        },
      };
    },
  };
}

const symbolReturnRows = (vals: Array<{ fqn: string; kind: string }>) =>
  vals.map((v, i) => ({ id: `id-${i}`, fqn: v.fqn, kind: v.kind }));

vi.mock("@/lib/db", () => {
  return {
    db: {
      insert(table: { _: { name: string } } | unknown) {
        const tableName = inferTableName(table);
        if (tableName === "code_symbols") {
          return {
            values(values: Array<{ fqn: string; kind: string }>) {
              const rows = symbolReturnRows(values);
              const cap: InsertCapture = { table: tableName, values };
              inserts.push(cap);
              return {
                onConflictDoUpdate({ target, set }: { target: unknown; set: unknown }) {
                  cap.onConflict = { target, set };
                  return {
                    returning() {
                      return Promise.resolve(rows);
                    },
                  };
                },
              };
            },
          };
        }
        return makeInsertChain(tableName, []);
      },
      update(table: unknown) {
        const tableName = inferTableName(table);
        return {
          set(setObj: Record<string, unknown>) {
            return {
              where(whereExpr: unknown) {
                updates.push({ table: tableName, set: setObj, where: whereExpr });
                return Promise.resolve(undefined);
              },
            };
          },
        };
      },
      delete(table: unknown) {
        const tableName = inferTableName(table);
        return {
          where(whereExpr: unknown) {
            deletes.push({ table: tableName, where: whereExpr });
            return Promise.resolve(undefined);
          },
        };
      },
    },
  };
});

function inferTableName(table: unknown): string {
  // Drizzle pgTable stores its name in a Symbol-keyed property. Find it by
  // walking own symbols.
  if (table && typeof table === "object") {
    for (const sym of Object.getOwnPropertySymbols(table)) {
      if (String(sym).includes("Name")) {
        const v = (table as Record<symbol, unknown>)[sym];
        if (typeof v === "string") return v;
      }
    }
  }
  return "unknown";
}

import { persistRepoExtraction, clearFiles, clearRepoState } from "../persist";

beforeEach(() => {
  inserts.length = 0;
  updates.length = 0;
  deletes.length = 0;
});

const baseExtraction: ExtractorOutput = {
  repoPath: "/tmp/x",
  symbols: [
    {
      fqn: "src/a.ts::foo",
      kind: "function",
      name: "foo",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 5,
      startCol: 0,
      endCol: 0,
      signature: "(x: number) => number",
      returnType: "number",
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
    {
      fqn: "src/a.ts::Cls",
      kind: "class",
      name: "Cls",
      filePath: "src/a.ts",
      startLine: 7,
      endLine: 12,
      startCol: 0,
      endCol: 0,
      signature: null,
      returnType: null,
      isAsync: false,
      isExported: false,
      isStatic: false,
      isAbstract: false,
      visibility: null,
      docComment: null,
      parentFqn: null,
      parentKind: null,
      language: "typescript",
      astHash: "h2",
    },
    {
      fqn: "src/a.ts::Cls.m",
      kind: "method",
      name: "m",
      filePath: "src/a.ts",
      startLine: 8,
      endLine: 10,
      startCol: 2,
      endCol: 0,
      signature: "() => void",
      returnType: "void",
      isAsync: false,
      isExported: false,
      isStatic: false,
      isAbstract: false,
      visibility: null,
      docComment: null,
      parentFqn: "src/a.ts::Cls",
      parentKind: "class",
      language: "typescript",
      astHash: "h3",
    },
  ],
  references: [
    {
      sourceFqn: "src/b.ts::caller",
      sourceKind: "function",
      targetFqn: "src/a.ts::foo",
      targetKind: "function",
      filePath: "src/b.ts",
      line: 4,
      col: 2,
      kind: "call",
    },
    {
      // Target not in catalogue — should be dropped silently.
      sourceFqn: null,
      sourceKind: null,
      targetFqn: "external::missing",
      targetKind: "function",
      filePath: "src/b.ts",
      line: 9,
      col: 0,
      kind: "call",
    },
  ],
  typeFacts: [
    {
      symbolFqn: "src/a.ts::foo",
      symbolKind: "function",
      paramTypes: [{ name: "x", type: "number", optional: false, defaultValue: null }],
      returnType: "number",
      genericParams: null,
      throws: null,
      sideEffects: null,
    },
  ],
  imports: [
    {
      sourceFile: "src/a.ts",
      targetModule: "react",
      resolvedFile: null,
      importedNames: ["useState"],
    },
  ],
  diagnostics: [],
  filesProcessed: 2,
  durationMs: 0,
};

describe("persistRepoExtraction", () => {
  it("inserts symbols with ON CONFLICT (repo_id, fqn, kind)", async () => {
    // Pre-stage: caller's source FQN must be in the catalogue for the
    // call-reference to land. We add it as a 4th symbol.
    const ext = {
      ...baseExtraction,
      symbols: [
        ...baseExtraction.symbols,
        {
          fqn: "src/b.ts::caller",
          kind: "function" as const,
          name: "caller",
          filePath: "src/b.ts",
          startLine: 1,
          endLine: 5,
          startCol: 0,
          endCol: 0,
          signature: null,
          returnType: null,
          isAsync: false,
          isExported: false,
          isStatic: false,
          isAbstract: false,
          visibility: null,
          docComment: null,
          parentFqn: null,
          parentKind: null,
          language: "typescript" as const,
          astHash: "hc",
        },
      ],
    };
    const result = await persistRepoExtraction(ext, { repoId: "r1", fullReindex: true });

    expect(result.symbolsInserted).toBe(4);
    // 1 valid reference (other was dropped because target was missing).
    expect(result.referencesInserted).toBe(1);
    expect(result.typeFactsInserted).toBe(1);
    expect(result.importsInserted).toBe(1);

    // Full re-index should have issued the 3 cascade-friendly DELETEs first.
    expect(deletes.map((d) => d.table)).toEqual([
      "code_imports",
      "code_references",
      "code_symbols",
    ]);

    // Symbol insert used the conflict target.
    const symbolInsert = inserts.find((i) => i.table === "code_symbols");
    expect(symbolInsert?.onConflict).toBeDefined();
  });

  it("incremental path uses clearedFilePaths and skips full purge", async () => {
    await persistRepoExtraction(
      { ...baseExtraction, symbols: [], references: [], typeFacts: [], imports: [] },
      { repoId: "r2", fullReindex: false, clearedFilePaths: ["src/a.ts"] },
    );

    expect(deletes.map((d) => d.table)).toEqual([
      "code_imports",
      "code_references",
      "code_symbols",
    ]);
    // No symbols/refs to insert.
    expect(inserts.length).toBe(0);
  });

  it("drops references whose TARGET isn't in the catalogue, keeps the rest", async () => {
    const result = await persistRepoExtraction(baseExtraction, {
      repoId: "r3",
      fullReindex: true,
    });
    // Two refs in baseExtraction: one targets src/a.ts::foo (in catalogue) —
    // kept. Source `src/b.ts::caller` isn't in catalogue, so source_symbol_id
    // is NULL but the row still inserts (file-scope ref pattern).
    // Second ref targets external::missing (NOT in catalogue) — dropped.
    expect(result.referencesInserted).toBe(1);
  });
});

describe("clearRepoState", () => {
  it("issues 3 DELETEs in cascade-safe order", async () => {
    await clearRepoState("r-clear");
    expect(deletes.map((d) => d.table)).toEqual([
      "code_imports",
      "code_references",
      "code_symbols",
    ]);
  });
});

describe("clearFiles", () => {
  it("issues 3 scoped DELETEs and skips when list is empty", async () => {
    await clearFiles("r-clear", []);
    expect(deletes.length).toBe(0);

    await clearFiles("r-clear", ["src/a.ts"]);
    expect(deletes.map((d) => d.table)).toEqual([
      "code_imports",
      "code_references",
      "code_symbols",
    ]);
  });
});
