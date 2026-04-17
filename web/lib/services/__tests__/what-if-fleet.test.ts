/**
 * Tests for the fleet verification service — VAR Gate 12.
 *
 * Covers idempotency (existing row returned not re-inserted), retry
 * of failed runs, status shaping with threshold math, and worker
 * enqueue interaction. The worker-side BullMQ handler has its own
 * tests in worker/src/jobs/__tests__ and isn't exercised here.
 *
 * Pattern matches the other service tests (chainable drizzle mock +
 * vi.hoisted for fetch).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let queryQueue: unknown[][] = [];
const insertReturning: unknown[] = [];
const updateCalls: { set: Record<string, unknown> }[] = [];
const fetchMock = vi.fn();

function chainable() {
  const obj: Record<string, unknown> = {};
  const methods = ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy", "set"];
  for (const m of methods) obj[m] = () => obj;
  obj.then = (resolve: (v: unknown) => void) => resolve(queryQueue.shift() ?? []);
  return obj;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chainable(),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve(insertReturning.shift() ?? [{ id: "run-new" }]),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateCalls.push({ set: v });
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  alerts: { id: "id", projectId: "project_id", sessionId: "session_id", fingerprint: "fingerprint" },
  substrateRecordings: { sessionId: "session_id" },
  remediationSessions: { id: "id" },
  fleetVerificationRuns: {
    id: "id",
    alertId: "alert_id",
    remediationId: "remediation_id",
    fixCommitSha: "fix_commit_sha",
    fingerprint: "fingerprint",
    status: "status",
    sessionsTotal: "sessions_total",
    sessionsAttempted: "sessions_attempted",
    countMatched: "count_matched",
    countUncertain: "count_uncertain",
    countWouldNotPrevent: "count_would_not_prevent",
    countErrored: "count_errored",
    sessionResults: "session_results",
    startedAt: "started_at",
    completedAt: "completed_at",
    error: "error",
    bullmqJobId: "bullmq_job_id",
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: ((c: unknown, v: unknown) => ({ c, v })) as unknown as typeof actual.eq,
    and: ((...args: unknown[]) => ({ and: args })) as unknown as typeof actual.and,
    inArray: ((c: unknown, v: unknown) => ({ c, v })) as unknown as typeof actual.inArray,
    isNotNull: ((c: unknown) => ({ c })) as unknown as typeof actual.isNotNull,
    desc: ((c: unknown) => ({ c })) as unknown as typeof actual.desc,
    sql: Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => ({ strings }),
      { raw: (s: string) => ({ raw: s }) },
    ),
  };
});

import {
  startOrGetFleetRun,
  getFleetRunForAlert,
  FLEET_PASS_THRESHOLD_PERCENT,
} from "@/lib/services/what-if-fleet";

const baseInput = {
  alertId: "alert-uuid-1",
  remediationId: "rem-uuid-1",
  fixCommitSha: "abc1234",
  fingerprint: "fp-1",
  githubToken: "ghp_test",
};

const ORIGINAL_WORKER_URL = process.env.WORKER_URL;
const ORIGINAL_SECRET = process.env.STAGING_API_SECRET;

beforeEach(() => {
  queryQueue = [];
  insertReturning.length = 0;
  updateCalls.length = 0;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.WORKER_URL = "https://worker.test";
  process.env.STAGING_API_SECRET = "test-secret";
});

function restoreEnv() {
  if (ORIGINAL_WORKER_URL === undefined) delete process.env.WORKER_URL;
  else process.env.WORKER_URL = ORIGINAL_WORKER_URL;
  if (ORIGINAL_SECRET === undefined) delete process.env.STAGING_API_SECRET;
  else process.env.STAGING_API_SECRET = ORIGINAL_SECRET;
}

// ── Idempotency ────────────────────────────────────────────────────────────

describe("startOrGetFleetRun — idempotency", () => {
  it("returns existing running row without re-enqueueing", async () => {
    queryQueue = [
      [
        {
          id: "existing-run",
          status: "running",
          sessionsTotal: 42,
          sessionsAttempted: 10,
          countMatched: 8,
          countUncertain: 1,
          countWouldNotPrevent: 1,
          countErrored: 0,
          sessionResults: [],
          startedAt: new Date("2026-04-17T10:00:00Z"),
          completedAt: null,
          error: null,
        },
      ],
      // readRun refresh call
      [
        {
          id: "existing-run",
          status: "running",
          sessionsTotal: 42,
          sessionsAttempted: 10,
          countMatched: 8,
          countUncertain: 1,
          countWouldNotPrevent: 1,
          countErrored: 0,
          sessionResults: [],
          startedAt: new Date("2026-04-17T10:00:00Z"),
          completedAt: null,
          error: null,
        },
      ],
    ];

    try {
      const r = await startOrGetFleetRun(baseInput);
      expect(r.runId).toBe("existing-run");
      expect(r.created).toBe(false);
      expect(r.status.status).toBe("running");
      // No fetch = no re-enqueue
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("re-enqueues when existing row is in failed state", async () => {
    queryQueue = [
      [
        {
          id: "failed-run",
          status: "failed",
          sessionsTotal: 10,
          sessionsAttempted: 3,
          countMatched: 0,
          countUncertain: 0,
          countWouldNotPrevent: 0,
          countErrored: 3,
          sessionResults: [],
          startedAt: new Date(),
          completedAt: new Date(),
          error: "worker unreachable",
        },
      ],
      // readRun after re-enqueue
      [
        {
          id: "failed-run",
          status: "running",
          sessionsTotal: 10,
          sessionsAttempted: 0,
          countMatched: 0,
          countUncertain: 0,
          countWouldNotPrevent: 0,
          countErrored: 0,
          sessionResults: [],
          startedAt: new Date(),
          completedAt: null,
          error: null,
        },
      ],
    ];

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ jobId: "job-2" }), { status: 201 }));

    try {
      const r = await startOrGetFleetRun(baseInput);
      expect(r.created).toBe(false);
      expect(r.status.status).toBe("running");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Worker enqueue call shape
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://worker.test/worker/enqueue");
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body).toMatchObject({
        queue: "low",
        name: "fleet-verification",
        data: { runId: "failed-run", githubToken: "ghp_test" },
      });
    } finally {
      restoreEnv();
    }
  });

  it("creates new row when none exists and enqueues worker job", async () => {
    // Queue: 1) existing lookup (empty) 2) candidate count: alerts row
    //        3) count candidates: related 4) recording filter
    //        5) final readRun
    queryQueue = [
      [], // no existing run
      [{ projectId: "proj-1", sessionId: "seed-session" }], // alert for count
      [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }], // related alerts
      [{ sessionId: "s1" }, { sessionId: "s2" }], // with recording
      [
        {
          id: "run-new",
          status: "running",
          sessionsTotal: 2,
          sessionsAttempted: 0,
          countMatched: 0,
          countUncertain: 0,
          countWouldNotPrevent: 0,
          countErrored: 0,
          sessionResults: [],
          startedAt: new Date(),
          completedAt: null,
          error: null,
        },
      ],
    ];
    insertReturning.push([{ id: "run-new" }]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ jobId: "job-1" }), { status: 201 }));

    try {
      const r = await startOrGetFleetRun(baseInput);
      expect(r.created).toBe(true);
      expect(r.runId).toBe("run-new");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      restoreEnv();
    }
  });
});

// ── Status shaping / threshold math ───────────────────────────────────────

describe("getFleetRunForAlert — status shaping", () => {
  it("returns null when no run exists", async () => {
    queryQueue = [[]];
    const r = await getFleetRunForAlert("alert-x");
    expect(r).toBeNull();
  });

  it("computes matchedPercent + passesThreshold for completed run", async () => {
    queryQueue = [
      [
        {
          id: "r1",
          status: "completed",
          sessionsTotal: 100,
          sessionsAttempted: 100,
          countMatched: 95,
          countUncertain: 3,
          countWouldNotPrevent: 2,
          countErrored: 0,
          sessionResults: [],
          startedAt: new Date("2026-04-17T10:00:00Z"),
          completedAt: new Date("2026-04-17T10:15:00Z"),
          error: null,
        },
      ],
    ];

    const r = await getFleetRunForAlert("alert-x");
    expect(r).toMatchObject({
      status: "completed",
      matchedPercent: 95,
      passesThreshold: true,
      countMatched: 95,
    });
  });

  it("passesThreshold=false when matched below 90%", async () => {
    queryQueue = [
      [
        {
          id: "r1",
          status: "completed",
          sessionsTotal: 100,
          sessionsAttempted: 100,
          countMatched: 80,
          countUncertain: 10,
          countWouldNotPrevent: 10,
          countErrored: 0,
          sessionResults: [],
          startedAt: new Date(),
          completedAt: new Date(),
          error: null,
        },
      ],
    ];
    const r = await getFleetRunForAlert("alert-x");
    expect(r?.matchedPercent).toBe(80);
    expect(r?.passesThreshold).toBe(false);
  });

  it("matchedPercent=null when sessionsTotal=0 (singleton)", async () => {
    queryQueue = [
      [
        {
          id: "r1",
          status: "completed",
          sessionsTotal: 0,
          sessionsAttempted: 0,
          countMatched: 0,
          countUncertain: 0,
          countWouldNotPrevent: 0,
          countErrored: 0,
          sessionResults: [],
          startedAt: new Date(),
          completedAt: new Date(),
          error: null,
        },
      ],
    ];
    const r = await getFleetRunForAlert("alert-x");
    expect(r?.matchedPercent).toBeNull();
    expect(r?.passesThreshold).toBe(false);
  });

  it("threshold constant is exposed (90%)", () => {
    expect(FLEET_PASS_THRESHOLD_PERCENT).toBe(90);
  });
});

// ── Worker enqueue error propagation ──────────────────────────────────────

describe("startOrGetFleetRun — worker errors", () => {
  it("throws when WORKER_URL is missing", async () => {
    queryQueue = [[], [{ projectId: "p", sessionId: null }], [], []];
    insertReturning.push([{ id: "run-x" }]);
    delete process.env.WORKER_URL;

    try {
      await expect(startOrGetFleetRun(baseInput)).rejects.toThrow(
        /requires WORKER_URL/,
      );
    } finally {
      restoreEnv();
    }
  });

  it("surfaces worker enqueue failure with HTTP status", async () => {
    queryQueue = [
      [],
      [{ projectId: "p", sessionId: null }],
      [],
      [],
      // final readRun won't be called because we throw first
    ];
    insertReturning.push([{ id: "run-x" }]);
    fetchMock.mockResolvedValue(new Response("overloaded", { status: 503 }));

    try {
      await expect(startOrGetFleetRun(baseInput)).rejects.toThrow(
        /enqueue fleet-verification failed \(503\)/,
      );
    } finally {
      restoreEnv();
    }
  });
});
