/**
 * Tests for summariseRecording — the helper that turns a Substrate
 * recording into a synthetic "source" the three-pass pipeline can
 * read. We don't assert exact wording (it'll evolve as the prompt
 * improves) — we assert the shape + invariants that downstream code
 * depends on.
 */

import { describe, it, expect } from "vitest";
import { summariseRecording } from "../test-from-recording";

const baseRec = {
  recordingId: "r_abcd1234",
  command: "node server.js",
  runtime: "node",
  eventCount: 3,
  durationMs: 142,
  categories: { http: 2, db: 1 } as Record<string, number>,
  events: [
    { seq: 0, kind: { type: "http_request", method: "GET", url: "/api/users/42" } },
    { seq: 1, kind: { type: "db_query", query: "SELECT * FROM users WHERE id=$1" } },
    { seq: 2, kind: { type: "http_response", status: 200 } },
  ],
};

describe("summariseRecording", () => {
  it("returns a header with recordingId + command + runtime", () => {
    const s = summariseRecording(baseRec);
    expect(s.eventsCompact).toContain("r_abcd1234");
    expect(s.eventsCompact).toContain("node server.js");
    expect(s.eventsCompact).toContain('runtime="node"');
  });

  it("renders each event type with seq + readable shape", () => {
    const s = summariseRecording(baseRec);
    expect(s.eventsCompact).toMatch(/\[seq=0\s+http_request\]\s+GET \/api\/users\/42/);
    expect(s.eventsCompact).toMatch(/\[seq=1\s+db_query\]\s+SELECT \* FROM users/);
    expect(s.eventsCompact).toMatch(/\[seq=2\s+http_response\]\s+status=200/);
  });

  it("derives suggestedPath from the first http_request", () => {
    const s = summariseRecording(baseRec);
    expect(s.suggestedPath).toBe("tests/api/users/42.test.ts");
  });

  it("falls back to generic path when no http_request is present", () => {
    const s = summariseRecording({
      ...baseRec,
      events: [{ seq: 0, kind: { type: "db_query", query: "SELECT 1" } }],
    });
    expect(s.suggestedPath).toBe("tests/from-recording.test.ts");
  });

  it("truncates event list past maxEvents and notes how many were dropped", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      seq: i,
      kind: { type: "db_query", query: `SELECT ${i}` },
    }));
    const s = summariseRecording({ ...baseRec, events: many }, 40);
    expect(s.eventsCompact).toContain("+20 more events truncated");
    expect(s.eventsCompact).toContain("[seq=0");
    expect(s.eventsCompact).toContain("[seq=39"); // last included event
  });

  it("returns event count + duration in the summary fields", () => {
    const s = summariseRecording(baseRec);
    expect(s.eventCount).toBe(3);
    expect(s.durationMs).toBe(142);
    expect(s.recordingId).toBe("r_abcd1234");
  });

  it("handles missing/null events gracefully", () => {
    const s = summariseRecording({ ...baseRec, events: null as unknown });
    expect(s.eventsCompact).toContain("r_abcd1234");
    expect(s.eventCount).toBe(3);
  });

  it("escapes quotes in command to keep the synthetic file parseable", () => {
    const s = summariseRecording({ ...baseRec, command: 'node -e "console.log()"' });
    expect(s.eventsCompact).toContain('command="node -e \\"console.log()\\""');
  });

  it("normalises path-style suggestions to a safe test file path", () => {
    const s = summariseRecording({
      ...baseRec,
      events: [
        { seq: 0, kind: { type: "http_request", method: "POST", url: "/api/users?id=42" } },
      ],
    });
    // Query string stripped, no leading slash, lowercase letters preserved
    expect(s.suggestedPath).toBe("tests/api/users.test.ts");
  });
});
