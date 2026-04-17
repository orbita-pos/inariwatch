/**
 * Tests for getFullTraceContextForAlert — the prompt-friendly text
 * formatter that ships with VAR Q1 Sesión 4.
 *
 * The contract is "produce a small, deterministic text block the AI can
 * reason about, OR return null". Tests pin down the boundaries:
 *   - Returns null when the alert has no session_id (legacy data)
 *   - Returns null when no replay row AND no substrate row (no time anchor)
 *   - Falls back to substrate's startedAt when replay row absent
 *   - Truncates at 30 events keeping the LATEST (recency = causal signal)
 *   - Renders relative time as +m:ss.mmm
 *   - Combines backend + AI events into one chronological stream
 *
 * Mock layout: same chainable-thenable pattern used by alert-impact tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let queryQueue: unknown[][] = [];

function chainable() {
  const obj: Record<string, unknown> = {};
  const methods = ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy", "groupBy"];
  for (const m of methods) obj[m] = () => obj;
  obj.then = (resolve: (v: unknown) => void) => resolve(queryQueue.shift() ?? []);
  return obj;
}

vi.mock("@/lib/db", () => ({
  db: { select: () => chainable() },
  alerts: { id: "id", sessionId: "session_id", title: "title", fingerprint: "fingerprint", projectId: "project_id" },
  replaySessions: { id: "id", sessionId: "session_id", startedAt: "started_at", endUserId: "end_user_id" },
  substrateRecordings: { recordingId: "recording_id", sessionId: "session_id", startedAt: "started_at", events: "events" },
  remediationSessions: { id: "id", alertId: "alert_id" },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: ((c: unknown, v: unknown) => ({ c, v })) as unknown as typeof actual.eq,
    and: ((...args: unknown[]) => ({ and: args })) as unknown as typeof actual.and,
    isNotNull: ((c: unknown) => ({ isNotNull: c })) as unknown as typeof actual.isNotNull,
  };
});

import { getFullTraceContextForAlert } from "@/lib/fulltrace/context-for-prompt";

beforeEach(() => {
  queryQueue = [];
});

describe("getFullTraceContextForAlert — degraded states", () => {
  it("returns null when alert has no session_id (legacy data)", async () => {
    queryQueue = [[{ sessionId: null, title: "X" }]];
    const r = await getFullTraceContextForAlert("alert-1");
    expect(r).toBeNull();
  });

  it("returns null when alert lookup returns nothing", async () => {
    queryQueue = [[]];
    const r = await getFullTraceContextForAlert("does-not-exist");
    expect(r).toBeNull();
  });

  it("returns null when there's no replay AND no substrate (no time anchor)", async () => {
    queryQueue = [
      [{ sessionId: "sess-1", title: "X" }], // alert has sessionId
      [], // replay_sessions empty
      [], // substrate_recordings empty
    ];
    const r = await getFullTraceContextForAlert("alert-1");
    expect(r).toBeNull();
  });

  it("returns null when both backend and ai event streams are empty", async () => {
    queryQueue = [
      [{ sessionId: "sess-1", title: "X" }],
      [{ startedAt: new Date(0) }], // replay_session anchor found
      // aggregateBackendEvents queries (substrate recordings + events)
      [], // no substrate recordings
      // aggregateAiEvents queries (alerts + remediations)
      [], // no alerts
    ];
    const r = await getFullTraceContextForAlert("alert-1");
    expect(r).toBeNull();
  });
});

describe("getFullTraceContextForAlert — formatting", () => {
  it("falls back to substrate startedAt when no replay row exists", async () => {
    queryQueue = [
      [{ sessionId: "sess-1", title: "X" }],
      [], // replay_sessions empty → fall back
      [{ startedAt: new Date(1_000_000) }], // substrate provides anchor
      // aggregateBackendEvents: 1 recording, 1 event
      [{
        recordingId: "rec-1",
        startedAt: new Date(1_000_000),
        events: [{ seq: 0, timestamp_ns: 0, parent_seq: null, kind: { type: "Marker", label: "ok" } }],
      }],
      // aggregateAiEvents: no alerts
      [],
    ];
    const r = await getFullTraceContextForAlert("alert-1");
    expect(r).not.toBeNull();
    expect(r).toContain("FullTrace causal chain");
    expect(r).toContain("ok");
  });

  it("renders ts as +m:ss.mmm relative time", async () => {
    queryQueue = [
      [{ sessionId: "sess-1", title: "X" }],
      [{ startedAt: new Date(0) }],
      [{
        // recording started 1:30.500 into the session — that offset alone
        // anchors the events even when there's only one.
        recordingId: "rec-1",
        startedAt: new Date(90_500),
        events: [
          { seq: 0, timestamp_ns: 0, parent_seq: null, kind: { type: "Marker", label: "later" } },
        ],
      }],
      [],
    ];
    const r = await getFullTraceContextForAlert("alert-1");
    expect(r).toContain("+1:30.500");
  });

  it("combines backend + AI events into one chronological stream", async () => {
    queryQueue = [
      [{ sessionId: "sess-1", title: "X" }],
      [{ startedAt: new Date(0) }],
      // backend: recording starts at +10s into the session, one event at the start
      [{
        recordingId: "rec-1",
        startedAt: new Date(10_000),
        events: [{ seq: 0, timestamp_ns: 0, parent_seq: null, kind: { type: "HttpRequest", method: "GET", url: "/x" } }],
      }],
      // ai: 1 alert at t=5s
      [{ id: "a-1", title: "Boom", severity: "critical", aiReasoning: null, isResolved: false, createdAt: new Date(5000), resolvedAt: null }],
      [], // no remediations
    ];
    const r = await getFullTraceContextForAlert("alert-1");
    // Order should be: ai alert (t=5s) → backend (t=10s)
    const aiIdx = r!.indexOf("Boom");
    const backendIdx = r!.indexOf("/x");
    expect(aiIdx).toBeLessThan(backendIdx);
    // Both rendered as B / A markers
    expect(r).toMatch(/A\s+alert/);
    expect(r).toMatch(/B\s+http/);
  });

  it("truncates at 30 events, keeps the LAST 30 (recency = causal signal)", async () => {
    // Generate 35 backend events
    const events = Array.from({ length: 35 }, (_, i) => ({
      seq: i,
      timestamp_ns: i * 1_000_000_000,
      parent_seq: null,
      kind: { type: "Marker", label: `event-${i}` },
    }));

    queryQueue = [
      [{ sessionId: "sess-1", title: "X" }],
      [{ startedAt: new Date(0) }],
      [{ recordingId: "rec-1", startedAt: new Date(0), events }],
      [],
    ];

    const r = await getFullTraceContextForAlert("alert-1");
    expect(r).toContain("showing last 30 of 35 events");
    // The LATEST events (event-30..event-34) should be in the output;
    // the EARLIEST (event-0..event-4) should be truncated.
    expect(r).toContain("event-34");
    expect(r).toContain("event-30");
    expect(r).not.toContain("event-0 ");
    expect(r).not.toContain("event-4 ");
  });

  it("does NOT mention truncation when event count <= 30", async () => {
    queryQueue = [
      [{ sessionId: "sess-1", title: "X" }],
      [{ startedAt: new Date(0) }],
      [{
        recordingId: "rec-1",
        startedAt: new Date(0),
        events: [{ seq: 0, timestamp_ns: 0, parent_seq: null, kind: { type: "Marker", label: "only-one" } }],
      }],
      [],
    ];
    const r = await getFullTraceContextForAlert("alert-1");
    expect(r).not.toContain("showing last");
    expect(r).not.toContain("trimmed");
  });

  it("includes session id (truncated to 16 chars) in the header", async () => {
    queryQueue = [
      [{ sessionId: "very-long-session-id-1234567890", title: "X" }],
      [{ startedAt: new Date(0) }],
      [{
        recordingId: "rec-1",
        startedAt: new Date(0),
        events: [{ seq: 0, timestamp_ns: 0, parent_seq: null, kind: { type: "Marker", label: "x" } }],
      }],
      [],
    ];
    const r = await getFullTraceContextForAlert("alert-1");
    expect(r).toContain("very-long-sessio");
  });
});
