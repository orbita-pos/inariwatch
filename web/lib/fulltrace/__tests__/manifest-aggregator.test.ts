/**
 * Tests for the FullTrace manifest aggregator.
 *
 * The aggregator is pure logic on top of two DB queries — we mock those
 * queries and pin down the timestamp normalization, category mapping,
 * and event ordering. Tests focus on the boundary cases that real data
 * tends to break:
 *   - Recordings with no events array (corrupted jsonb)
 *   - Mixed recordings whose start times differ from the session start
 *   - Multiple alerts → multiple remediations N+1 query path
 *   - Missing optional fields (status, durationMs, errorMessage)
 *   - Tone derivation when the input severity isn't recognized
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock — programmable per test via the queue ──────────────────────────
//
// Each call to `db.select()...where()` shifts one result off the queue.
// Tests configure the queue per scenario in their setup. `tableSpy` lets
// assertions confirm we hit the right table in the right order.

let queryQueue: unknown[][] = [];
const tableSpy = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        tableSpy(table);
        return {
          where: () => {
            const next = queryQueue.shift() ?? [];
            return next;
          },
        };
      },
    }),
  },
  // The aggregator imports these table identifiers — mock as opaque
  // tokens so `eq()` doesn't choke on missing columns. The test itself
  // never inspects them.
  substrateRecordings: { name: "substrate_recordings", sessionId: "session_id" },
  alerts: { name: "alerts", sessionId: "session_id", id: "id" },
  remediationSessions: { name: "remediation_sessions", alertId: "alert_id" },
}));

// Keep the real drizzle-orm exports (sql, and, or, etc. — used by schema.ts
// during module init) and only override `eq` so we don't poison every other
// module-level call. The aggregator only needs eq() to satisfy the call
// signature; the result object is opaque to our DB mock.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: ((col: unknown, val: unknown) => ({ col, val })) as unknown as typeof actual.eq,
  };
});

import {
  aggregateBackendEvents,
  aggregateAiEvents,
} from "@/lib/fulltrace/manifest-aggregator";

beforeEach(() => {
  queryQueue = [];
  tableSpy.mockClear();
});

// ── aggregateBackendEvents ─────────────────────────────────────────────────

describe("aggregateBackendEvents", () => {
  it("returns [] when no recordings exist", async () => {
    queryQueue = [[]];
    const out = await aggregateBackendEvents("sess-1", 0);
    expect(out).toEqual([]);
  });

  it("returns [] when recording exists but events is null/missing", async () => {
    queryQueue = [
      [{ recordingId: "rec-1", events: null, startedAt: new Date(0) }],
    ];
    const out = await aggregateBackendEvents("sess-1", 0);
    expect(out).toEqual([]);
  });

  it("flattens HttpRequest events with correct category and summary", async () => {
    queryQueue = [
      [{
        recordingId: "rec-1",
        startedAt: new Date(0),
        events: [
          { seq: 0, timestamp_ns: 0,             kind: { type: "HttpRequest",  method: "POST", url: "/api/x" } },
          { seq: 1, timestamp_ns: 1_500_000_000, kind: { type: "HttpResponse", status: 200,    duration_ms: 1500 } },
        ],
      }],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "rec-1-0",
      ts: 0,
      category: "http",
      type: "HttpRequest",
      summary: "POST /api/x",
      recordingId: "rec-1",
    });
    expect(out[1]).toMatchObject({
      id: "rec-1-1",
      ts: 1500,
      category: "http",
      type: "HttpResponse",
      summary: "200 (1500ms)",
      durationMs: 1500,
      status: 200,
    });
  });

  it("converts timestamp_ns deltas to session-relative ms", async () => {
    queryQueue = [
      [{
        recordingId: "rec-1",
        startedAt: new Date(10_000), // recording started 10s into session
        events: [
          { seq: 0, timestamp_ns: 5_000_000_000, kind: { type: "Marker", label: "start" } },
          { seq: 1, timestamp_ns: 5_500_000_000, kind: { type: "Marker", label: "mid"   } },
        ],
      }],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    // First event: recordingOffset=10000 + intra=0 = 10000
    // Second: 10000 + 500ms = 10500
    expect(out[0].ts).toBe(10_000);
    expect(out[1].ts).toBe(10_500);
  });

  it("maps every known Substrate type to its category", async () => {
    queryQueue = [
      [{
        recordingId: "rec-1",
        startedAt: new Date(0),
        events: [
          { seq: 0,  timestamp_ns: 0, kind: { type: "DbQuery",      query: "SELECT 1" } },
          { seq: 1,  timestamp_ns: 0, kind: { type: "FileRead",     path: "/etc/x"   } },
          { seq: 2,  timestamp_ns: 0, kind: { type: "FileWrite",    path: "/tmp/y"   } },
          { seq: 3,  timestamp_ns: 0, kind: { type: "DnsResolve",   hostname: "x.com" } },
          { seq: 4,  timestamp_ns: 0, kind: { type: "Exception",    name: "TypeError", message: "oops" } },
          { seq: 5,  timestamp_ns: 0, kind: { type: "ProcessStart", command: "ls"    } },
          { seq: 6,  timestamp_ns: 0, kind: { type: "TimeNow",      value: 1234       } },
          { seq: 7,  timestamp_ns: 0, kind: { type: "RandomFloat" } },
          { seq: 8,  timestamp_ns: 0, kind: { type: "Marker",       label: "x"       } },
          { seq: 9,  timestamp_ns: 0, kind: { type: "UnknownType",  data: "x"        } },
        ],
      }],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    expect(out.map((e) => e.category)).toEqual([
      "db", "fs", "fs", "dns", "exception", "process", "time", "random", "marker", "marker",
    ]);
  });

  it("sorts output by ts ascending across multiple recordings", async () => {
    queryQueue = [
      [
        {
          recordingId: "rec-late",
          startedAt: new Date(20_000),
          events: [{ seq: 0, timestamp_ns: 0, kind: { type: "Marker", label: "late" } }],
        },
        {
          recordingId: "rec-early",
          startedAt: new Date(5_000),
          events: [{ seq: 0, timestamp_ns: 0, kind: { type: "Marker", label: "early" } }],
        },
      ],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    expect(out.map((e) => e.summary)).toEqual(["early", "late"]);
  });

  it("surfaces errorMessage only for Exception events with a message", async () => {
    queryQueue = [
      [{
        recordingId: "rec-1",
        startedAt: new Date(0),
        events: [
          { seq: 0, timestamp_ns: 0, kind: { type: "Exception", name: "Err", message: "boom" } },
          { seq: 1, timestamp_ns: 0, kind: { type: "HttpResponse", status: 500 } },
        ],
      }],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    expect(out[0].errorMessage).toBe("boom");
    expect(out[1].errorMessage).toBeUndefined();
  });

  it("skips events with non-object kind (corrupted jsonb)", async () => {
    queryQueue = [
      [{
        recordingId: "rec-1",
        startedAt: new Date(0),
        events: [
          { seq: 0, timestamp_ns: 0, kind: null },
          { seq: 1, timestamp_ns: 0, kind: "not-an-object" },
          { seq: 2, timestamp_ns: 0, kind: { type: "Marker", label: "ok" } },
        ],
      }],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe("ok");
  });
});

// ── aggregateAiEvents ──────────────────────────────────────────────────────

describe("aggregateAiEvents", () => {
  it("returns [] when no alerts exist for the session", async () => {
    queryQueue = [[]];
    const out = await aggregateAiEvents("sess-1", 0);
    expect(out).toEqual([]);
  });

  it("emits one alert event per alert + a diagnosis when aiReasoning is present", async () => {
    queryQueue = [
      // alerts query
      [
        { id: "alert-1", title: "Bug A", severity: "critical", aiReasoning: "Stripe timeout", isResolved: false, createdAt: new Date(1000), resolvedAt: null },
      ],
      // remediation query for alert-1
      [],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "alert", title: "Bug A", tone: "critical", alertId: "alert-1", ts: 1000 });
    expect(out[1]).toMatchObject({ kind: "diagnosis", title: "AI diagnosis ready", alertId: "alert-1", ts: 1001 });
  });

  it("omits diagnosis when aiReasoning is null", async () => {
    queryQueue = [
      [
        { id: "alert-1", title: "X", severity: "warning", aiReasoning: null, isResolved: false, createdAt: new Date(0), resolvedAt: null },
      ],
      [],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("alert");
  });

  it("emits remediation lifecycle events: start + steps + completion", async () => {
    queryQueue = [
      [
        { id: "alert-1", title: "X", severity: "info", aiReasoning: null, isResolved: false, createdAt: new Date(0), resolvedAt: null },
      ],
      [
        {
          id: "rem-1",
          alertId: "alert-1",
          status: "completed",
          steps: [
            { type: "diagnose", message: "diagnosing", status: "completed", timestamp: "1970-01-01T00:00:00.500Z" },
            { type: "fix",      message: "writing fix", status: "completed", timestamp: "1970-01-01T00:00:01.000Z" },
          ],
          prUrl: "https://github.com/o/r/pull/1",
          mergedCommitSha: "abc123",
          revertPrUrl: null,
          monitoringStatus: null,
          createdAt: new Date(100),
          updatedAt: new Date(2000),
        },
      ],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    // alert + 2 steps + start + completion = 5
    expect(out).toHaveLength(5);
    const kinds = out.map((e) => e.kind);
    expect(kinds).toContain("remediation_started");
    expect(kinds).toContain("remediation_step");
    expect(kinds).toContain("fix_merged"); // mergedCommitSha is set
  });

  it("emits remediation_failed when status is failed", async () => {
    queryQueue = [
      [
        { id: "alert-1", title: "X", severity: "info", aiReasoning: null, isResolved: false, createdAt: new Date(0), resolvedAt: null },
      ],
      [
        {
          id: "rem-1",
          alertId: "alert-1",
          status: "failed",
          steps: [],
          prUrl: null,
          mergedCommitSha: null,
          revertPrUrl: null,
          monitoringStatus: null,
          createdAt: new Date(100),
          updatedAt: new Date(2000),
        },
      ],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    expect(out.find((e) => e.kind === "remediation_failed")).toBeDefined();
  });

  it("emits fix_reverted when monitoring detects regression", async () => {
    queryQueue = [
      [
        { id: "alert-1", title: "X", severity: "info", aiReasoning: null, isResolved: false, createdAt: new Date(0), resolvedAt: null },
      ],
      [
        {
          id: "rem-1",
          alertId: "alert-1",
          status: "completed",
          steps: [],
          prUrl: "https://github.com/o/r/pull/1",
          mergedCommitSha: "abc",
          revertPrUrl: "https://github.com/o/r/pull/2",
          monitoringStatus: "reverted",
          createdAt: new Date(100),
          updatedAt: new Date(2000),
        },
      ],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    const revert = out.find((e) => e.kind === "fix_reverted");
    expect(revert).toBeDefined();
    expect(revert!.body).toBe("https://github.com/o/r/pull/2");
    expect(revert!.tone).toBe("danger");
  });

  it("derives severity tone from alert.severity (defaults to info on unknown)", async () => {
    queryQueue = [
      [
        { id: "a-1", title: "A", severity: "critical", aiReasoning: null, isResolved: false, createdAt: new Date(0), resolvedAt: null },
        { id: "a-2", title: "B", severity: "warning",  aiReasoning: null, isResolved: false, createdAt: new Date(1), resolvedAt: null },
        { id: "a-3", title: "C", severity: "weird",    aiReasoning: null, isResolved: false, createdAt: new Date(2), resolvedAt: null },
      ],
      [], [], [],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    expect(out.find((e) => e.alertId === "a-1")?.tone).toBe("critical");
    expect(out.find((e) => e.alertId === "a-2")?.tone).toBe("warning");
    expect(out.find((e) => e.alertId === "a-3")?.tone).toBe("info");
  });

  it("output is sorted by ts ascending", async () => {
    queryQueue = [
      [
        { id: "alert-1", title: "X", severity: "info", aiReasoning: "diag", isResolved: false, createdAt: new Date(5000), resolvedAt: null },
      ],
      [
        {
          id: "rem-1",
          alertId: "alert-1",
          status: "completed",
          steps: [{ type: "step", message: "halfway", status: "completed", timestamp: "1970-01-01T00:00:06.000Z" }],
          prUrl: null,
          mergedCommitSha: null,
          revertPrUrl: null,
          monitoringStatus: null,
          createdAt: new Date(5500),
          updatedAt: new Date(7000),
        },
      ],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
    }
  });
});
