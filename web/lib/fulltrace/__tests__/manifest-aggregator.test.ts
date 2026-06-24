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
  crossLinkBackendAndAi,
  type BackendEvent,
  type AiEvent,
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

// ── Causal linking ─────────────────────────────────────────────────────────

describe("causal linking — backend parent_seq", () => {
  it("links child to parent via parent_seq within same recording", async () => {
    queryQueue = [
      [{
        recordingId: "rec-1",
        startedAt: new Date(0),
        events: [
          { seq: 0, timestamp_ns: 0,         parent_seq: null, kind: { type: "HttpRequest", method: "POST", url: "/api/x" } },
          { seq: 1, timestamp_ns: 500_000,   parent_seq: 0,    kind: { type: "DbQuery",     query: "SELECT 1" } },
          { seq: 2, timestamp_ns: 1_000_000, parent_seq: 0,    kind: { type: "HttpResponse", status: 200, duration_ms: 1 } },
        ],
      }],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    const parent = out.find((e) => e.id === "rec-1-0")!;
    const child1 = out.find((e) => e.id === "rec-1-1")!;
    const child2 = out.find((e) => e.id === "rec-1-2")!;

    // Forward links — parent knows its children
    expect(parent.relatedIds).toContain("rec-1-1");
    expect(parent.relatedIds).toContain("rec-1-2");
    // Backward links — children know their parent
    expect(child1.relatedIds).toEqual(["rec-1-0"]);
    expect(child2.relatedIds).toEqual(["rec-1-0"]);
  });

  it("does NOT link across recordings (parent_seq is recording-local)", async () => {
    queryQueue = [
      [
        {
          recordingId: "rec-A", startedAt: new Date(0),
          events: [{ seq: 0, timestamp_ns: 0, parent_seq: null, kind: { type: "HttpRequest", method: "GET", url: "/" } }],
        },
        {
          recordingId: "rec-B", startedAt: new Date(0),
          // parent_seq=0 in rec-B should NOT link to rec-A's seq 0.
          events: [{ seq: 1, timestamp_ns: 0, parent_seq: 0, kind: { type: "DbQuery", query: "x" } }],
        },
      ],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    // No parent in rec-B (seq 0 doesn't exist there) → child has empty links.
    const child = out.find((e) => e.id === "rec-B-1")!;
    expect(child.relatedIds).toEqual([]);
  });

  it("handles missing parent_seq gracefully (no relatedIds)", async () => {
    queryQueue = [
      [{
        recordingId: "rec-1", startedAt: new Date(0),
        events: [
          { seq: 0, timestamp_ns: 0, parent_seq: null, kind: { type: "Marker", label: "x" } },
          { seq: 1, timestamp_ns: 0, kind: { type: "Marker", label: "y" } }, // parent_seq absent
        ],
      }],
    ];

    const out = await aggregateBackendEvents("sess-1", 0);
    expect(out[0].relatedIds).toEqual([]);
    expect(out[1].relatedIds).toEqual([]);
  });
});

describe("causal linking — AI siblings", () => {
  it("links events sharing the same alertId (alert ↔ diagnosis)", async () => {
    queryQueue = [
      [
        { id: "alert-1", title: "X", severity: "info", aiReasoning: "Stripe timeout", isResolved: false, createdAt: new Date(0), resolvedAt: null },
      ],
      [],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    const alert = out.find((e) => e.id === "alert-alert-1")!;
    const diag = out.find((e) => e.id === "diag-alert-1")!;

    expect(alert.relatedIds).toContain(diag.id);
    expect(diag.relatedIds).toContain(alert.id);
  });

  it("links remediation lifecycle events that share a remediationId", async () => {
    queryQueue = [
      [
        { id: "alert-1", title: "X", severity: "info", aiReasoning: null, isResolved: false, createdAt: new Date(0), resolvedAt: null },
      ],
      [
        {
          id: "rem-1", alertId: "alert-1", status: "completed",
          steps: [
            { type: "diagnose", message: "step1", status: "completed", timestamp: "1970-01-01T00:00:01.000Z" },
            { type: "fix",      message: "step2", status: "completed", timestamp: "1970-01-01T00:00:02.000Z" },
          ],
          prUrl: null, mergedCommitSha: null, revertPrUrl: null, monitoringStatus: null,
          createdAt: new Date(0), updatedAt: new Date(3000),
        },
      ],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    const start = out.find((e) => e.id === "rem-start-rem-1")!;
    const step1 = out.find((e) => e.id === "rem-step-rem-1-0")!;
    const step2 = out.find((e) => e.id === "rem-step-rem-1-1")!;
    const end   = out.find((e) => e.id === "rem-done-rem-1")!;

    // Sibling-by-remediationId AND sibling-by-alertId both fire — every
    // event in the rem lifecycle should reference the others.
    for (const sibling of [step1, step2, end]) {
      expect(start.relatedIds).toContain(sibling.id);
    }
  });

  it("does NOT include the event itself in its own relatedIds", async () => {
    queryQueue = [
      [
        { id: "alert-1", title: "X", severity: "info", aiReasoning: "x", isResolved: false, createdAt: new Date(0), resolvedAt: null },
      ],
      [],
    ];

    const out = await aggregateAiEvents("sess-1", 0);
    for (const e of out) {
      expect(e.relatedIds).not.toContain(e.id);
    }
  });
});

describe("crossLinkBackendAndAi", () => {
  function bk(id: string, category: BackendEvent["category"], status?: number): BackendEvent {
    return { id, ts: 0, category, type: "X", summary: "", recordingId: "rec-1", relatedIds: [], ...(status !== undefined ? { status } : {}) };
  }
  function al(id: string, kind: AiEvent["kind"] = "alert"): AiEvent {
    return { id, ts: 0, kind, title: "X", relatedIds: [] };
  }

  it("links every alert to every backend exception in the session", () => {
    const backend = [
      bk("be-1", "http", 200),       // ok — should NOT link
      bk("be-2", "exception"),       // should link
      bk("be-3", "http", 500),       // should link (5xx)
      bk("be-4", "http", 404),       // 4xx — should NOT link (the rule is 5xx only)
    ];
    const ai = [al("alert-1"), al("alert-2")];

    crossLinkBackendAndAi(backend, ai);

    expect(ai[0].relatedIds.sort()).toEqual(["be-2", "be-3"]);
    expect(ai[1].relatedIds.sort()).toEqual(["be-2", "be-3"]);
    expect(backend[0].relatedIds).toEqual([]);   // 200 OK untouched
    expect(backend[1].relatedIds.sort()).toEqual(["alert-1", "alert-2"]); // exception
    expect(backend[2].relatedIds.sort()).toEqual(["alert-1", "alert-2"]); // 5xx
    expect(backend[3].relatedIds).toEqual([]);   // 4xx untouched
  });

  it("is a no-op when no alerts exist", () => {
    const backend = [bk("be-1", "exception")];
    const ai: AiEvent[] = [];
    crossLinkBackendAndAi(backend, ai);
    expect(backend[0].relatedIds).toEqual([]);
  });

  it("is a no-op when no failures exist (all OK responses)", () => {
    const backend = [bk("be-1", "http", 200)];
    const ai = [al("alert-1")];
    crossLinkBackendAndAi(backend, ai);
    expect(ai[0].relatedIds).toEqual([]);
    expect(backend[0].relatedIds).toEqual([]);
  });

  it("does NOT link non-alert AI events (diagnoses, remediation steps)", () => {
    const backend = [bk("be-1", "exception")];
    const ai = [al("diag-1", "diagnosis"), al("step-1", "remediation_step")];
    crossLinkBackendAndAi(backend, ai);
    // Only alerts get cross-linked. Diagnosis/step rely on sibling-by-alertId.
    expect(backend[0].relatedIds).toEqual([]);
  });

  it("is idempotent — calling twice doesn't duplicate ids", () => {
    const backend = [bk("be-1", "exception")];
    const ai = [al("alert-1")];
    crossLinkBackendAndAi(backend, ai);
    crossLinkBackendAndAi(backend, ai);
    expect(backend[0].relatedIds).toEqual(["alert-1"]);
    expect(ai[0].relatedIds).toEqual(["be-1"]);
  });
});
