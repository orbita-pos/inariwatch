import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CodeSymbol, CodeReference, CodeTypeFact, CodeImport } from "@/lib/db/schema";

// Stub Drizzle's `db` builder. We capture every query the queries module
// issues and let the test pre-stage the rows that come back. Drizzle's
// chaining shape is what makes this gnarly — match it just enough.

interface TableMatcher {
  name: string;
  rows: unknown[];
}

const queryLog: Array<{ table: string; ids?: unknown }> = [];
let symbolRows: CodeSymbol[] = [];
let referenceRows: CodeReference[] = [];
let typeFactRows: CodeTypeFact[] = [];
let importRows: CodeImport[] = [];

function tableNameFromArg(arg: unknown): string {
  if (arg && typeof arg === "object") {
    for (const sym of Object.getOwnPropertySymbols(arg)) {
      if (String(sym).includes("Name")) {
        const v = (arg as Record<symbol, unknown>)[sym];
        if (typeof v === "string") return v;
      }
    }
  }
  return "unknown";
}

vi.mock("@/lib/db", () => {
  const select = (table: TableMatcher | unknown): unknown => {
    return {
      from(arg: unknown) {
        const name = typeof arg === "string" ? arg : tableNameFromArg(arg);
        queryLog.push({ table: name });
        const matched: unknown[] =
          name === "code_symbols"
            ? symbolRows
            : name === "code_references"
              ? referenceRows
              : name === "code_type_facts"
                ? typeFactRows
                : name === "code_imports"
                  ? importRows
                  : [];
        const result = {
          where(_w: unknown) {
            return Object.assign(Promise.resolve(matched), this);
          },
          orderBy(_o: unknown) {
            return this;
          },
          limit(_n: number) {
            return Object.assign(Promise.resolve(matched), this);
          },
          then(resolve: (v: unknown) => void) {
            resolve(matched);
          },
        };
        return result;
      },
    };
  };

  return {
    db: {
      select(...args: unknown[]) {
        return select(args[0]);
      },
    },
  };
});

import {
  blastRadius,
  findDefinition,
  findReferences,
  searchSemantic,
  typeAt,
  whoImports,
  getSymbolByFqn,
} from "../queries";

beforeEach(() => {
  queryLog.length = 0;
  symbolRows = [];
  referenceRows = [];
  typeFactRows = [];
  importRows = [];
});

const mkSymbol = (overrides: Partial<CodeSymbol> = {}): CodeSymbol => ({
  id: overrides.id ?? "s-1",
  repoId: "r1",
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
  parentId: null,
  language: "typescript",
  astHash: "h1",
  indexedAt: new Date(),
  ...overrides,
});

const mkRef = (overrides: Partial<CodeReference> = {}): CodeReference => ({
  id: overrides.id ?? "r-1",
  repoId: "r1",
  sourceSymbolId: null,
  targetSymbolId: "s-1",
  filePath: "src/b.ts",
  line: 4,
  col: 0,
  kind: "call",
  ...overrides,
});

describe("findDefinition / getSymbolByFqn", () => {
  it("returns null when no rows match", async () => {
    symbolRows = [];
    const def = await findDefinition("missing", "r1");
    expect(def).toBeNull();
    expect(queryLog[0]?.table).toBe("code_symbols");
  });

  it("prefers value-bearing kinds when declaration merging is in play", async () => {
    // namespace + interface + class share an FQN; class wins.
    symbolRows = [
      mkSymbol({ id: "s-iface", kind: "interface" }),
      mkSymbol({ id: "s-ns", kind: "namespace" }),
      mkSymbol({ id: "s-cls", kind: "class" }),
    ];
    const def = await findDefinition("src/a.ts::Vehicle", "r1");
    expect(def?.id).toBe("s-cls");
  });
});

describe("findReferences", () => {
  it("walks symbols-by-fqn → refs-by-target", async () => {
    symbolRows = [mkSymbol()];
    referenceRows = [mkRef(), mkRef({ id: "r-2", line: 7 })];
    const refs = await findReferences("src/a.ts::foo", "r1");
    expect(refs.length).toBe(2);
    expect(queryLog.map((q) => q.table)).toEqual(["code_symbols", "code_references"]);
  });

  it("returns [] when symbol not found (no reference query issued)", async () => {
    symbolRows = [];
    const refs = await findReferences("src/a.ts::missing", "r1");
    expect(refs.length).toBe(0);
    expect(queryLog.map((q) => q.table)).toEqual(["code_symbols"]);
  });
});

describe("typeAt", () => {
  it("returns the innermost symbol covering the line + enriches with type-facts", async () => {
    const outer = mkSymbol({ id: "outer", startLine: 1, endLine: 50 });
    const inner = mkSymbol({ id: "inner", startLine: 10, endLine: 20 });
    symbolRows = [outer, inner];
    typeFactRows = [
      {
        id: "tf-1",
        symbolId: "inner",
        paramTypes: null,
        returnType: "Promise<User>",
        genericParams: null,
        throws: null,
        sideEffects: null,
      },
    ];
    const out = await typeAt("src/a.ts", 15, null, "r1");
    expect(out?.symbol?.id).toBe("inner");
    expect(out?.type).toBe("Promise<User>");
  });

  it("returns null when no symbol covers the line", async () => {
    symbolRows = [];
    const out = await typeAt("src/a.ts", 15, null, "r1");
    expect(out).toBeNull();
  });
});

describe("blastRadius", () => {
  it("clamps depth to [1, 5]", async () => {
    symbolRows = [mkSymbol()];
    const r1 = await blastRadius("src/a.ts::foo", "r1", 0);
    expect(r1.depth).toBe(1);
    const r2 = await blastRadius("src/a.ts::foo", "r1", 99);
    expect(r2.depth).toBe(5);
  });

  it("returns empty when seed not in catalogue", async () => {
    symbolRows = [];
    const r = await blastRadius("src/a.ts::missing", "r1");
    expect(r.symbols).toEqual([]);
  });
});

describe("searchSemantic", () => {
  it("FQN fast-path: query containing :: hits findDefinition", async () => {
    symbolRows = [mkSymbol()];
    const out = await searchSemantic("src/a.ts::foo", "r1");
    expect(out.length).toBe(1);
    expect(out[0]?.symbol.fqn).toBe("src/a.ts::foo");
  });

  it("name search with shallow=true skips enrichment queries", async () => {
    symbolRows = [mkSymbol()];
    const out = await searchSemantic("foo", "r1", { shallow: true });
    expect(out.length).toBe(1);
    expect(out[0]?.callers).toEqual([]);
    expect(out[0]?.callees).toEqual([]);
    expect(out[0]?.typeFacts).toBeNull();
    // Exactly one query — the symbol search. No enrichment.
    expect(queryLog.length).toBe(1);
  });

  it("name search without shallow enriches with refs + facts", async () => {
    symbolRows = [mkSymbol()];
    referenceRows = [mkRef()];
    typeFactRows = [];
    const out = await searchSemantic("foo", "r1");
    expect(out.length).toBe(1);
    // 1 symbol query + 2 reference queries (callers + callees) + 1 type-facts query.
    expect(queryLog.map((q) => q.table)).toEqual([
      "code_symbols",
      "code_references",
      "code_references",
      "code_type_facts",
    ]);
  });

  it("returns [] for empty query string", async () => {
    const out = await searchSemantic("   ", "r1");
    expect(out).toEqual([]);
    expect(queryLog.length).toBe(0);
  });
});

describe("whoImports", () => {
  it("queries code_imports with the module path", async () => {
    importRows = [
      {
        id: "i-1",
        repoId: "r1",
        sourceFile: "src/a.ts",
        targetModule: "./helpers",
        resolvedFile: "src/helpers.ts",
        importedNames: ["helper"],
      },
    ];
    const out = await whoImports("src/helpers.ts", "r1");
    expect(out.length).toBe(1);
    expect(queryLog.map((q) => q.table)).toEqual(["code_imports"]);
  });
});

describe("getSymbolByFqn", () => {
  it("returns the first matching row", async () => {
    symbolRows = [mkSymbol(), mkSymbol({ id: "s-2", kind: "interface" })];
    const out = await getSymbolByFqn("src/a.ts::foo", "r1");
    expect(out?.id).toBe("s-1");
  });
});
