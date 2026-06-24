import { describe, expect, it } from "vitest";

import { adaptV2ToV1, topFqns, topFqnsFromV1 } from "../adapter";
import type { CodeReference, CodeSymbol } from "@/lib/db/schema";
import type { SemanticSearchResult } from "../queries";

const mkSymbol = (overrides: Partial<CodeSymbol> = {}): CodeSymbol => ({
  id: "s-1",
  repoId: "r1",
  fqn: "src/a.ts::foo",
  kind: "function",
  name: "foo",
  filePath: "src/a.ts",
  startLine: 1,
  endLine: 5,
  startCol: 0,
  endCol: 0,
  signature: null,
  returnType: null,
  isAsync: false,
  isExported: true,
  isStatic: false,
  isAbstract: false,
  visibility: null,
  docComment: "Friendly docs.",
  parentId: null,
  language: "typescript",
  astHash: "h1",
  indexedAt: new Date(),
  ...overrides,
});

const mkRef = (overrides: Partial<CodeReference> = {}): CodeReference => ({
  id: "ref-1",
  repoId: "r1",
  sourceSymbolId: "src-id",
  targetSymbolId: "t-id",
  filePath: "src/b.ts",
  line: 7,
  col: 0,
  kind: "call",
  ...overrides,
});

describe("adaptV2ToV1", () => {
  it("preserves filePath / name / start-end lines / docstring", () => {
    const v2: SemanticSearchResult[] = [{ symbol: mkSymbol(), callers: [], callees: [], typeFacts: null }];
    const out = adaptV2ToV1(v2);
    expect(out[0]).toMatchObject({
      chunkId: "s-1",
      filePath: "src/a.ts",
      name: "foo",
      startLine: 1,
      endLine: 5,
      docstring: "Friendly docs.",
      language: "typescript",
      code: "",
      score: 1,
    });
  });

  it("decays score with rank", () => {
    const v2: SemanticSearchResult[] = [
      { symbol: mkSymbol({ id: "a" }), callers: [], callees: [], typeFacts: null },
      { symbol: mkSymbol({ id: "b" }), callers: [], callees: [], typeFacts: null },
      { symbol: mkSymbol({ id: "c" }), callers: [], callees: [], typeFacts: null },
    ];
    const out = adaptV2ToV1(v2);
    expect(out[0]?.score).toBe(1);
    expect(out[1]?.score).toBeCloseTo(0.5);
    expect(out[2]?.score).toBeCloseTo(1 / 3);
  });

  it("maps kinds to v1 chunkType", () => {
    const cases: Array<[CodeSymbol["kind"], string]> = [
      ["function", "function"],
      ["class", "class"],
      ["method", "method"],
      ["type", "type"],
      ["variable", "type"],
      ["interface", "type"],
      ["enum", "type"],
      ["namespace", "module"],
    ];
    for (const [kind, expected] of cases) {
      const v2: SemanticSearchResult[] = [{ symbol: mkSymbol({ kind }), callers: [], callees: [], typeFacts: null }];
      const out = adaptV2ToV1(v2);
      expect(out[0]?.chunkType).toBe(expected);
    }
  });

  it("filters callers without sourceSymbolId; keeps callees", () => {
    const v2: SemanticSearchResult[] = [
      {
        symbol: mkSymbol(),
        callers: [
          mkRef({ id: "c1", sourceSymbolId: "ss-1" }),
          mkRef({ id: "c2", sourceSymbolId: null }),
        ],
        callees: [mkRef({ id: "ce-1" })],
        typeFacts: null,
      },
    ];
    const out = adaptV2ToV1(v2);
    expect(out[0]?.callers?.length).toBe(1);
    expect(out[0]?.callees?.length).toBe(1);
    expect(out[0]?.callers?.[0]?.name).toMatch(/src\/b\.ts:7/);
  });
});

describe("topFqns / topFqnsFromV1", () => {
  it("topFqns trims to n", () => {
    const v2: SemanticSearchResult[] = Array.from({ length: 25 }, (_, i) => ({
      symbol: mkSymbol({ fqn: `f${i}` }),
      callers: [],
      callees: [],
      typeFacts: null,
    }));
    expect(topFqns(v2)).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}`));
    expect(topFqns(v2, 3)).toEqual(["f0", "f1", "f2"]);
  });

  it("topFqnsFromV1 reconstructs `<filePath>::<name>` from v1 results", () => {
    const v1 = [
      { chunkId: "x", filePath: "src/a.ts", name: "foo" } as never,
      { chunkId: "y", filePath: "src/b.ts", name: "bar" } as never,
    ];
    expect(topFqnsFromV1(v1)).toEqual(["src/a.ts::foo", "src/b.ts::bar"]);
  });
});
