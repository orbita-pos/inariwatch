/**
 * Rollout service — security hotfix test coverage.
 *
 * Focus: M3 optimistic CAS guard in advanceStage + rollback.
 * A concurrent second call that moves the stage between our SELECT and
 * UPDATE must throw "stage changed concurrently — retry" rather than
 * silently last-write-wins clobber the first mutation. The DB-level
 * signal is an empty .returning() array (no row matched the CAS WHERE).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocking strategy mirrors lib/services/__tests__/alert-impact.test.ts —
// chainable query-builder where each SELECT consumes one entry from
// selectQueue and each UPDATE().returning() consumes one entry from
// updateReturnQueue.

let selectQueue: unknown[][] = [];
let updateReturnQueue: Array<Array<{ id: string }>> = [];

function selectChain() {
  const obj: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) obj[m] = () => obj;
  obj.then = (resolve: (v: unknown) => void) => resolve(selectQueue.shift() ?? []);
  return obj;
}

function updateChain() {
  const obj: Record<string, unknown> = {};
  obj.set = () => obj;
  obj.where = () => obj;
  obj.returning = () =>
    new Promise<Array<{ id: string }>>((resolve) =>
      resolve(updateReturnQueue.shift() ?? []),
    );
  return obj;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => selectChain(),
    update: () => updateChain(),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  rolloutRuns: {
    id: "id",
    currentStage: "current_stage",
    alertId: "alert_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
  desc: (col: unknown) => ({ _desc: col }),
}));

// Dynamic import so the vi.mock shims above apply before the module loads.
const loadService = async () => await import("../rollout.service");

beforeEach(() => {
  selectQueue = [];
  updateReturnQueue = [];
});

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    alertId: "00000000-0000-4000-8000-0000000000aa",
    currentStage: "canary_1",
    stageStartedAt: new Date("2026-04-17T00:00:00Z"),
    stageHistory: [
      {
        stage: "canary_1",
        startedAt: "2026-04-17T00:00:00Z",
        endedAt: null,
        outcome: "running",
        metrics: {},
        triggeredBy: "user:seed",
      },
    ],
    autoRollbackEnabled: true,
    rollbackReason: null,
    rollbackPrUrl: null,
    thresholdNewErrors: 0,
    thresholdUptimeFailures: 1,
    thresholdFingerprintRegressions: 0,
    status: "active",
    error: null,
    startedAt: new Date("2026-04-17T00:00:00Z"),
    completedAt: null,
    ...overrides,
  };
}

// ── advanceStage ─────────────────────────────────────────────────────────

describe("advanceStage — M3 CAS guard", () => {
  it("throws when the UPDATE affects zero rows (concurrent stage change)", async () => {
    const { advanceStage } = await loadService();

    // 1st SELECT: returns the run in canary_1.
    selectQueue.push([baseRow()]);
    // UPDATE .returning() — empty array means CAS lost the race.
    updateReturnQueue.push([]);

    await expect(
      advanceStage({
        runId: "00000000-0000-4000-8000-000000000001",
        triggeredBy: "user:test",
      }),
    ).rejects.toThrow(/stage changed concurrently/);
  });

  it("succeeds when the UPDATE returns the run id (CAS matched)", async () => {
    const { advanceStage } = await loadService();

    selectQueue.push([baseRow()]);
    // CAS succeeded, one row updated.
    updateReturnQueue.push([{ id: "00000000-0000-4000-8000-000000000001" }]);
    // Final re-read returns the advanced state.
    selectQueue.push([baseRow({ currentStage: "canary_10" })]);

    const status = await advanceStage({
      runId: "00000000-0000-4000-8000-000000000001",
      triggeredBy: "user:test",
    });
    expect(status.currentStage).toBe("canary_10");
  });

  it("refuses to advance out of a terminal stage", async () => {
    const { advanceStage } = await loadService();

    selectQueue.push([baseRow({ currentStage: "complete" })]);

    await expect(
      advanceStage({
        runId: "00000000-0000-4000-8000-000000000001",
        triggeredBy: "user:test",
      }),
    ).rejects.toThrow(/terminal stage/);
  });
});

// ── rollback ─────────────────────────────────────────────────────────────

describe("rollback — M3 CAS guard", () => {
  it("throws when the UPDATE affects zero rows (concurrent stage change)", async () => {
    const { rollback } = await loadService();

    selectQueue.push([baseRow()]);
    updateReturnQueue.push([]); // CAS lost the race.

    await expect(
      rollback({
        runId: "00000000-0000-4000-8000-000000000001",
        triggeredBy: "user:test",
        reason: "tests",
      }),
    ).rejects.toThrow(/stage changed concurrently/);
  });

  it("succeeds when CAS matches — reverted state returned", async () => {
    const { rollback } = await loadService();

    selectQueue.push([baseRow()]);
    updateReturnQueue.push([{ id: "00000000-0000-4000-8000-000000000001" }]);
    selectQueue.push([
      baseRow({
        currentStage: "reverted",
        status: "reverted",
        rollbackReason: "tests",
        completedAt: new Date("2026-04-17T00:01:00Z"),
      }),
    ]);

    const status = await rollback({
      runId: "00000000-0000-4000-8000-000000000001",
      triggeredBy: "user:test",
      reason: "tests",
    });
    expect(status.currentStage).toBe("reverted");
    expect(status.status).toBe("reverted");
    expect(status.rollbackReason).toBe("tests");
  });

  it("refuses to rollback out of a terminal stage", async () => {
    const { rollback } = await loadService();

    selectQueue.push([baseRow({ currentStage: "reverted" })]);

    await expect(
      rollback({
        runId: "00000000-0000-4000-8000-000000000001",
        triggeredBy: "user:test",
        reason: "tests",
      }),
    ).rejects.toThrow(/terminal stage/);
  });
});

// ── shape — sanity for the canAdvance/nextStage UI helpers ───────────────

describe("shape — UI helpers reflect stage transitions", () => {
  it("canAdvance=true + nextStage set when currentStage is non-terminal", async () => {
    const { getRolloutForAlert } = await loadService();

    selectQueue.push([baseRow({ currentStage: "canary_10" })]);

    const status = await getRolloutForAlert("00000000-0000-4000-8000-0000000000aa");
    expect(status?.canAdvance).toBe(true);
    expect(status?.nextStage).toBe("canary_50");
  });

  it("canAdvance=false + nextStage=null when currentStage is terminal", async () => {
    const { getRolloutForAlert } = await loadService();

    selectQueue.push([baseRow({ currentStage: "complete" })]);

    const status = await getRolloutForAlert("00000000-0000-4000-8000-0000000000aa");
    expect(status?.canAdvance).toBe(false);
    expect(status?.nextStage).toBeNull();
  });
});
