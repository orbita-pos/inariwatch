/**
 * Phase 1.5 — service-layer dispatcher contract.
 *
 * `searchCode()` must keep returning v1 results when the flag is "off"
 * (default) and "shadow", and switch to v2 (adapted to v1 shape) when "on".
 * In shadow mode it must ALSO write one row to `code_intel_shadow_log` per
 * call without breaking the caller if logging fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_BACKUP = process.env.CODE_INTEL_V2;

// ── Mocks ────────────────────────────────────────────────────────────────────

// v1 search returns deterministic placeholder rows.
vi.mock("@/lib/code-intelligence/search", () => ({
  searchCodeByProject: vi.fn(async () => [
    {
      chunkId: "v1-1",
      filePath: "src/v1.ts",
      name: "v1Symbol",
      chunkType: "function",
      startLine: 1,
      endLine: 5,
      code: "v1 code",
      docstring: null,
      language: "typescript",
      score: 0.9,
    },
  ]),
}));

// v2 query returns one symbol that the adapter will translate.
vi.mock("@/lib/code-intelligence-v2/queries", () => ({
  searchSemantic: vi.fn(async () => [
    {
      symbol: {
        id: "s-2",
        repoId: "r1",
        fqn: "src/v2.ts::v2Symbol",
        kind: "function",
        name: "v2Symbol",
        filePath: "src/v2.ts",
        startLine: 10,
        endLine: 20,
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
        parentId: null,
        language: "typescript",
        astHash: "h1",
        indexedAt: new Date(),
      },
      callers: [],
      callees: [],
      typeFacts: null,
    },
  ]),
}));

// Mock `db` so we can capture the shadow-log INSERT and the readiness lookup.
const dbState = {
  shadowInserts: [] as unknown[],
  readyRepoIds: ["r1"] as string[],
};

vi.mock("@/lib/db", async () => {
  return {
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve(
                      dbState.readyRepoIds.length > 0
                        ? [{ id: dbState.readyRepoIds[0] }]
                        : [],
                    );
                  },
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          values(rows: unknown[] | unknown) {
            dbState.shadowInserts.push(rows);
            return Promise.resolve(undefined);
          },
        };
      },
    },
    // The service imports table refs via `@/lib/db` re-exports — unused
    // by the mock since we never branch on table identity here.
    codeRepositories: {},
    codeChunks: {},
    codeIntelShadowLog: {},
  };
});

vi.mock("@/lib/code-intelligence/logger", () => ({
  logCodeIntelEvent: vi.fn(),
}));

// Indexer module is also imported by the service. Provide a no-op stub.
vi.mock("@/lib/code-intelligence/indexer", () => ({
  indexRepository: vi.fn(),
}));

import { searchCodeByProject } from "@/lib/code-intelligence/search";
import { searchSemantic } from "@/lib/code-intelligence-v2/queries";

const v1Mock = vi.mocked(searchCodeByProject);
const v2Mock = vi.mocked(searchSemantic);

beforeEach(async () => {
  v1Mock.mockClear();
  v2Mock.mockClear();
  dbState.shadowInserts.length = 0;
  dbState.readyRepoIds = ["r1"];
  delete process.env.CODE_INTEL_V2;
  // Importing the service must come after env is reset so tests don't
  // accidentally cache a resolved engine inside the module. The flag
  // resolver reads process.env on every call, so a fresh import is not
  // strictly required, but resetMODULES keeps mocks consistent.
});

afterEach(() => {
  if (ENV_BACKUP === undefined) delete process.env.CODE_INTEL_V2;
  else process.env.CODE_INTEL_V2 = ENV_BACKUP;
});

describe("searchCode dispatch", () => {
  it("default (off) → only v1 runs", async () => {
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    const out = await searchCode({ projectId: "p1", query: "foo" });
    expect(v1Mock).toHaveBeenCalledTimes(1);
    expect(v2Mock).not.toHaveBeenCalled();
    expect(out[0]?.chunkId).toBe("v1-1");
    expect(dbState.shadowInserts.length).toBe(0);
  });

  it("on → v2 results returned, adapted to v1 shape", async () => {
    process.env.CODE_INTEL_V2 = "on";
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    const out = await searchCode({ projectId: "p1", query: "foo" });
    expect(v2Mock).toHaveBeenCalledTimes(1);
    // Adapted: v2's first row shows up with chunkId = symbol id, code="".
    expect(out[0]?.chunkId).toBe("s-2");
    expect(out[0]?.code).toBe("");
    expect(out[0]?.name).toBe("v2Symbol");
  });

  it("on with no ready repo → falls back to v1 transparently", async () => {
    process.env.CODE_INTEL_V2 = "on";
    dbState.readyRepoIds = [];
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    const out = await searchCode({ projectId: "p1", query: "foo" });
    expect(v1Mock).toHaveBeenCalledTimes(1);
    expect(out[0]?.chunkId).toBe("v1-1");
  });

  it("shadow → v1 returned, v2 also invoked, one shadow-log row written", async () => {
    process.env.CODE_INTEL_V2 = "shadow";
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    const out = await searchCode({ projectId: "p1", query: "foo" });
    expect(v1Mock).toHaveBeenCalledTimes(1);
    expect(v2Mock).toHaveBeenCalledTimes(1);
    // Caller gets v1.
    expect(out[0]?.chunkId).toBe("v1-1");
    // One shadow-log insert.
    expect(dbState.shadowInserts.length).toBe(1);
    const row = dbState.shadowInserts[0] as Record<string, unknown>;
    expect(row.query).toBe("foo");
    expect(row.v1ResultCount).toBe(1);
    expect(row.v2ResultCount).toBe(1);
    expect(Array.isArray(row.v1TopFqns)).toBe(true);
    expect(Array.isArray(row.v2TopFqns)).toBe(true);
  });

  it("getCodeIntelEngine reads the env var", async () => {
    process.env.CODE_INTEL_V2 = "shadow";
    const { getCodeIntelEngine } = await import("@/lib/services/code-intelligence.service");
    expect(getCodeIntelEngine()).toBe("shadow");
  });
});
