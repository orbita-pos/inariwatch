/**
 * Phase 3.1 — Shadow harness controls (kill switch / sampling / timeout).
 *
 * Sits alongside service-dispatch.test.ts (Phase 1.5) which already covers
 * the basic engine-routing matrix. This file targets the new operator
 * knobs:
 *
 *   1. Kill switch (`CODE_INTEL_V2_KILL_SHADOW=1`) — shadow becomes a no-op,
 *      v2 is never invoked, no shadow row written.
 *   2. Sampling — `SHADOW_SAMPLE_RATE=0` skips v2 every time; `=1` always
 *      runs it. Per-workspace pct override beats env when present.
 *   3. Timeout guard — when v2 overshoots the 2× v1 budget, the dispatcher
 *      returns v1 immediately and writes a row with `v2TimedOut=true`.
 *
 * The `sampling` module is mocked so we control the dice + the workspace
 * lookup deterministically. The DB is mocked via the same hand-rolled
 * shape used by service-dispatch.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_BACKUP = {
  CODE_INTEL_V2: process.env.CODE_INTEL_V2,
  SHADOW_SAMPLE_RATE: process.env.SHADOW_SAMPLE_RATE,
  CODE_INTEL_V2_KILL_SHADOW: process.env.CODE_INTEL_V2_KILL_SHADOW,
  CODE_INTEL_V2_MIN_V2_BUDGET_MS: process.env.CODE_INTEL_V2_MIN_V2_BUDGET_MS,
};

// ── Mocks ──────────────────────────────────────────────────────────────────

const sampleStub = vi.fn(async () => true);
const killStub = vi.fn(() => false);
const budgetStub = vi.fn((v1Ms: number) => Math.max(v1Ms, 50));

vi.mock("@/lib/code-intelligence-v2/sampling", () => ({
  isShadowKilled: () => killStub(),
  shouldShadowSample: (projectId: string) => sampleStub(),
  v2AdditionalBudgetMs: (v1Ms: number) => budgetStub(v1Ms),
}));

const v1Mock = vi.fn(async () => [
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
]);

vi.mock("@/lib/code-intelligence/search", () => ({
  searchCodeByProject: (...args: unknown[]) => v1Mock(),
}));

// v2 mock with adjustable delay so timeout tests can exercise the race.
const v2State = {
  delayMs: 0,
  shouldThrow: false,
};

vi.mock("@/lib/code-intelligence-v2/queries", () => ({
  searchSemantic: vi.fn(async () => {
    if (v2State.delayMs > 0) {
      await new Promise((r) => setTimeout(r, v2State.delayMs));
    }
    if (v2State.shouldThrow) throw new Error("v2 explode");
    return [
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
    ];
  }),
}));

const dbState = {
  shadowInserts: [] as Record<string, unknown>[],
};

vi.mock("@/lib/db", () => ({
  db: {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve([{ id: "r1" }]);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(rows: Record<string, unknown>) {
          dbState.shadowInserts.push(rows);
          return Promise.resolve(undefined);
        },
      };
    },
  },
  codeRepositories: {},
  codeChunks: {},
  codeIntelShadowLog: {},
  organizations: {},
  projects: {},
}));

vi.mock("@/lib/code-intelligence/logger", () => ({
  logCodeIntelEvent: vi.fn(),
}));

vi.mock("@/lib/code-intelligence/indexer", () => ({
  indexRepository: vi.fn(),
}));

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  process.env.CODE_INTEL_V2 = "shadow";
  delete process.env.CODE_INTEL_V2_KILL_SHADOW;
  delete process.env.SHADOW_SAMPLE_RATE;
  delete process.env.CODE_INTEL_V2_MIN_V2_BUDGET_MS;
  v1Mock.mockClear();
  sampleStub.mockClear().mockResolvedValue(true);
  killStub.mockClear().mockReturnValue(false);
  budgetStub.mockClear().mockImplementation((v1Ms) => Math.max(v1Ms, 50));
  v2State.delayMs = 0;
  v2State.shouldThrow = false;
  dbState.shadowInserts.length = 0;
});

afterEach(() => {
  for (const [k, v] of Object.entries(ENV_BACKUP)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("kill switch", () => {
  it("CODE_INTEL_V2_KILL_SHADOW=1 → shadow behaves like off, no v2, no log", async () => {
    killStub.mockReturnValue(true);
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    const out = await searchCode({ projectId: "p1", query: "foo" });
    expect(out[0]?.chunkId).toBe("v1-1");
    expect(sampleStub).not.toHaveBeenCalled();
    expect(dbState.shadowInserts.length).toBe(0);
    // v1 ran exactly once.
    expect(v1Mock).toHaveBeenCalledTimes(1);
  });

  it("kill switch off + sampling on → shadow runs as before", async () => {
    killStub.mockReturnValue(false);
    sampleStub.mockResolvedValue(true);
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    await searchCode({ projectId: "p1", query: "foo" });
    expect(dbState.shadowInserts.length).toBe(1);
  });
});

describe("sampling rate", () => {
  it("sample=false → skips v2 entirely (engine appears 'off' for this call)", async () => {
    sampleStub.mockResolvedValue(false);
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    const out = await searchCode({ projectId: "p1", query: "foo" });
    expect(out[0]?.chunkId).toBe("v1-1");
    expect(dbState.shadowInserts.length).toBe(0);
  });

  it("per-call sampling — alternating decisions yield matching log row counts", async () => {
    const { searchCode } = await import("@/lib/services/code-intelligence.service");

    sampleStub.mockResolvedValueOnce(true);
    await searchCode({ projectId: "p1", query: "q1" });
    expect(dbState.shadowInserts.length).toBe(1);

    sampleStub.mockResolvedValueOnce(false);
    await searchCode({ projectId: "p1", query: "q2" });
    expect(dbState.shadowInserts.length).toBe(1); // unchanged

    sampleStub.mockResolvedValueOnce(true);
    await searchCode({ projectId: "p1", query: "q3" });
    expect(dbState.shadowInserts.length).toBe(2);
  });
});

describe("timeout guard", () => {
  it("v2 finishing within budget → row has v2TimedOut=false and full v2 stats", async () => {
    v2State.delayMs = 5;
    budgetStub.mockReturnValue(200); // generous
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    await searchCode({ projectId: "p1", query: "foo" });
    expect(dbState.shadowInserts.length).toBe(1);
    const row = dbState.shadowInserts[0]!;
    expect(row.v2TimedOut).toBe(false);
    expect(row.v2ResultCount).toBe(1);
    expect(row.v2Error).toBeNull();
  });

  it("v2 overshooting budget → caller still gets v1, row has v2TimedOut=true", async () => {
    v2State.delayMs = 200;
    budgetStub.mockReturnValue(15);
    const { searchCode } = await import("@/lib/services/code-intelligence.service");

    const t0 = Date.now();
    const out = await searchCode({ projectId: "p1", query: "foo" });
    const elapsed = Date.now() - t0;

    // Caller got v1 — and didn't pay for the slow v2 (returned in well
    // under v2's 200ms delay).
    expect(out[0]?.chunkId).toBe("v1-1");
    expect(elapsed).toBeLessThan(150);

    expect(dbState.shadowInserts.length).toBe(1);
    const row = dbState.shadowInserts[0]!;
    expect(row.v2TimedOut).toBe(true);
    expect(row.v2ResultCount).toBe(0);
    expect(typeof row.v2Error).toBe("string");
    expect(row.v2Error as string).toMatch(/v2_slow:/);
  });

  it("v2 throwing inside budget → row has v2TimedOut=false but v2Error populated", async () => {
    v2State.shouldThrow = true;
    v2State.delayMs = 5;
    budgetStub.mockReturnValue(200);
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    const out = await searchCode({ projectId: "p1", query: "foo" });
    expect(out[0]?.chunkId).toBe("v1-1");
    const row = dbState.shadowInserts[0]!;
    expect(row.v2TimedOut).toBe(false);
    expect(row.v2Error).toBe("v2 explode");
  });

  it("budget passed to v2AdditionalBudgetMs is the v1 wall-clock", async () => {
    v2State.delayMs = 0;
    budgetStub.mockReturnValue(50);
    const { searchCode } = await import("@/lib/services/code-intelligence.service");
    await searchCode({ projectId: "p1", query: "foo" });
    expect(budgetStub).toHaveBeenCalledTimes(1);
    const arg = budgetStub.mock.calls[0]?.[0] ?? -1;
    expect(arg).toBeGreaterThanOrEqual(0);
  });
});
