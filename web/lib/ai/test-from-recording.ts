/**
 * Inari Guard — generate tests FROM a Substrate recording.
 *
 * Substrate captures real I/O — HTTP calls, DB queries, FS reads/writes —
 * during a production session. A recording is the ground-truth shape of
 * "what actually happens" through this code path. We can use that as the
 * test oracle: generate a regression test that replays the recorded I/O
 * and asserts the response/side-effects match.
 *
 * This is the moat for Inari Guard. Most test-gen tools (TestSprite,
 * Cursor's test mode, etc.) synthesise hypothetical scenarios from
 * source code. Inari Guard generates from REAL traces, which means:
 *   - The tests cover the exact paths that actually run in prod.
 *   - The expected outputs are observed values, not LLM guesses.
 *   - Edge cases the AI would never have invented (race conditions,
 *     malformed-but-accepted inputs, partial DB writes) show up.
 *
 * MVP approach (this file): convert the recording's events into a
 * pseudo "source" string that the three-pass pipeline treats like a
 * file. The LLM sees a structured event log and generates a test that
 * mirrors it. This is intentionally NOT trying to build the full
 * "Substrate replay → test" pipeline yet — that's Phase 2.
 *
 * Phase 2 (future): emit a real Substrate replay test that hooks into
 * the `@inariwatch/substrate-agent` SDK to set up fixtures and assert
 * each event matches. That gives bit-exact behavioural replay.
 */

interface SubstrateEvent {
  seq: number;
  timestamp_ns?: number;
  kind: { type: string; [key: string]: unknown };
  parent_seq?: number | null;
  stack?: string | null;
}

export interface RecordingSummary {
  recordingId: string;
  command: string | null;
  runtime: string | null;
  eventCount: number;
  durationMs: number | null;
  categories: Record<string, number> | null;
  /** First N events serialised compactly. */
  eventsCompact: string;
  /** Top-level entry surface detected — used as the suggested file path. */
  suggestedPath: string;
}

/**
 * Build the synthetic "source content" + suggested path the
 * three-pass pipeline will treat as the unit under test.
 *
 * The LLM receives this in place of normal source code, so we shape
 * it like a clear spec: a header explaining the format, then a
 * structured event listing.
 *
 * The shaped output:
 *   ```
 *   // SUBSTRATE RECORDING — recording_id="r_..." command="node server.js"
 *   // The events below are real I/O captured from a production run.
 *   // Generate a regression test that exercises this same code path
 *   // and asserts the I/O matches.
 *   //
 *   // [seq=0  http_request]   GET /api/users/42                  → status=200
 *   // [seq=1  db_query]       SELECT * FROM users WHERE id=$1    → rows=1
 *   // [seq=2  http_response]  200 application/json               body=…
 *   ```
 */
export function summariseRecording(
  recording: {
    recordingId: string;
    command: string | null;
    runtime: string | null;
    eventCount: number | null;
    durationMs: number | null;
    categories: unknown;
    events: unknown;
  },
  maxEvents = 40,
): RecordingSummary {
  const events: SubstrateEvent[] = Array.isArray(recording.events)
    ? (recording.events as SubstrateEvent[])
    : [];
  const categories =
    recording.categories && typeof recording.categories === "object"
      ? (recording.categories as Record<string, number>)
      : null;

  const head = events.slice(0, maxEvents);
  const lines: string[] = [];
  lines.push(
    `// SUBSTRATE RECORDING — recording_id="${recording.recordingId}"`
    + (recording.command ? ` command="${escape(recording.command)}"` : "")
    + (recording.runtime ? ` runtime="${escape(recording.runtime)}"` : ""),
  );
  lines.push(`// ${recording.eventCount ?? events.length} events captured`
    + (recording.durationMs ? `, duration=${recording.durationMs}ms` : "")
    + ".");
  lines.push("// The events below are real I/O captured from a production run.");
  lines.push("// Generate a regression test that exercises this same code path");
  lines.push("// and asserts the I/O matches.");
  lines.push("");
  for (const ev of head) {
    lines.push(formatEvent(ev));
  }
  if (events.length > head.length) {
    lines.push(`// … +${events.length - head.length} more events truncated.`);
  }

  // Suggested path — fall back to a generic test file name. The pipeline
  // will overwrite this with whatever the LLM prefers anyway.
  const suggestedPath = suggestPathFromEvents(events) ?? "tests/from-recording.test.ts";

  return {
    recordingId: recording.recordingId,
    command: recording.command,
    runtime: recording.runtime,
    eventCount: recording.eventCount ?? events.length,
    durationMs: recording.durationMs,
    categories,
    eventsCompact: lines.join("\n"),
    suggestedPath,
  };
}

function formatEvent(ev: SubstrateEvent): string {
  const seq = ev.seq;
  const type = ev.kind?.type ?? "unknown";
  switch (type) {
    case "http_request":
    case "HttpRequest":
      return `// [seq=${seq}  http_request]   ${str(ev.kind.method)} ${str(ev.kind.url ?? ev.kind.path)}`;
    case "http_response":
    case "HttpResponse":
      return `// [seq=${seq}  http_response]  status=${ev.kind.status ?? "?"}`;
    case "db_query":
    case "DbQuery":
      return `// [seq=${seq}  db_query]       ${truncate(str(ev.kind.query ?? ev.kind.sql), 80)}`;
    case "fs_read":
    case "FsRead":
      return `// [seq=${seq}  fs_read]        ${str(ev.kind.path)}`;
    case "fs_write":
    case "FsWrite":
      return `// [seq=${seq}  fs_write]       ${str(ev.kind.path)}`;
    case "spawn":
    case "Spawn":
      return `// [seq=${seq}  spawn]          ${str(ev.kind.command)}`;
    case "error":
    case "Error":
      return `// [seq=${seq}  error]          ${str(ev.kind.message)}`;
    default:
      return `// [seq=${seq}  ${type.padEnd(14)}] ${JSON.stringify(ev.kind).slice(0, 80)}`;
  }
}

/**
 * Heuristic: if the first http_request has a path, use it as the
 * suggested test path. e.g. GET /api/users → `tests/api/users.test.ts`.
 * Otherwise fall back to a generic name.
 */
function suggestPathFromEvents(events: SubstrateEvent[]): string | null {
  for (const ev of events) {
    if (ev.kind?.type === "http_request" || ev.kind?.type === "HttpRequest") {
      const raw = ev.kind.url ?? ev.kind.path;
      if (typeof raw === "string") {
        const path = raw.split("?")[0].replace(/^\/+/, "").replace(/\/+/g, "/");
        const slug = path.replace(/[^a-zA-Z0-9/]/g, "-").replace(/\/$/, "");
        if (slug) return `tests/${slug}.test.ts`;
      }
    }
  }
  return null;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function escape(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ");
}
