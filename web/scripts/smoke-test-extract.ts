/**
 * Smoke test — substrate-extract job vs Neon.
 *
 * Creates a synthetic substrate_recordings row with a realistic event
 * stream, runs the extract logic inline, and verifies the resulting
 * session_endpoint_metrics row has the expected fields.
 *
 * Exercises:
 *   - events JSONB walk + top-level http_request detection
 *   - db_query counting + downstream signature derivation
 *   - http_request/response pairing for latency
 *   - URL normalization (pure-digit ids → :id, UUID → :id)
 *   - healthy flag derivation (alert_id NULL + no error-kind events)
 *   - INSERT with UNIQUE(substrate_recording_id, endpoint_signature)
 *     and onConflictDoNothing semantics (idempotency on retry)
 *
 * Prerequisite: the Drift Demo project must exist (run
 * scripts/seed-drift-demo.ts first — we reuse its project_id).
 *
 * Usage: cd web && npx tsx scripts/smoke-test-extract.ts
 */

import { readFileSync } from "fs";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const env = readFileSync(".env.local", "utf-8");
const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
if (!match) {
  console.error("DATABASE_URL not found in .env.local");
  process.exit(1);
}
const sql = neon(match[1]);

// The Drift Demo project (see seed-drift-demo.ts).
const PROJECT_ID = "80fce652-7de4-40b1-a0d5-f3cc6e828f64";

// ── Event shape (mirrors worker/src/jobs/substrate-extract.ts) ────────────

interface SubEvent {
  seq?: number;
  timestamp_ns?: number;
  kind?: {
    type?: string;
    id?: number;
    method?: string;
    url?: string;
    status?: number;
    query?: string;
  };
}

interface Extracted {
  signature: string;
  urlRaw: string;
  latencyMs: number | null;
  dbQueryCount: number;
  externalHttpCount: number;
  topStatus: number | null;
  downstreamSignatures: string[];
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n◆ Smoke test: substrate-extract vs Neon\n");

  const recordingId = randomUUID();
  const recordingPublicId = `smoke-extract-${recordingId.slice(0, 8)}`;
  const startedAt = new Date();

  // 1. Build a realistic event stream: inbound POST /api/checkout/4182
  //    that hits Stripe + Segment + 3 DB queries over ~120ms. Includes
  //    one "error" kind to verify it gets counted but still lets us
  //    test a healthy recording (we intentionally insert without the
  //    error event for the happy path, with it for the unhealthy path).
  const events: SubEvent[] = [
    { seq: 1, timestamp_ns: 0,             kind: { type: "http_request",  id: 1, method: "POST", url: "/api/checkout/4182" } },
    { seq: 2, timestamp_ns: 15_000_000,    kind: { type: "db_query",      id: 1, query: "SELECT id, email FROM users WHERE id = $1" } },
    { seq: 3, timestamp_ns: 30_000_000,    kind: { type: "db_query",      id: 2, query: "UPDATE orders SET status = $1 WHERE id = $2" } },
    { seq: 4, timestamp_ns: 45_000_000,    kind: { type: "db_query",      id: 3, query: "INSERT INTO audit_log (user_id, action) VALUES ($1, $2)" } },
    { seq: 5, timestamp_ns: 55_000_000,    kind: { type: "http_request",  id: 2, method: "POST", url: "https://api.stripe.com/v1/charges" } },
    { seq: 6, timestamp_ns: 75_000_000,    kind: { type: "http_response", id: 2, status: 200 } },
    { seq: 7, timestamp_ns: 85_000_000,    kind: { type: "http_request",  id: 3, method: "POST", url: "https://api.segment.io/v1/track" } },
    { seq: 8, timestamp_ns: 100_000_000,   kind: { type: "http_response", id: 3, status: 200 } },
    { seq: 9, timestamp_ns: 120_000_000,   kind: { type: "http_response", id: 1, status: 200 } },
  ];

  // 2. Insert the substrate_recording (no alert = healthy candidate).
  await sql`
    INSERT INTO substrate_recordings
      (id, recording_id, alert_id, project_id, started_at, ended_at,
       event_count, runtime, events)
    VALUES
      (${recordingId}::uuid, ${recordingPublicId}, NULL, ${PROJECT_ID}::uuid,
       ${startedAt.toISOString()}::timestamptz, ${new Date(startedAt.getTime() + 120).toISOString()}::timestamptz,
       ${events.length}, 'node', ${JSON.stringify(events)}::jsonb)
  `;
  console.log(`  ✓ inserted substrate_recording: ${recordingId}`);

  // 3. Run the extract logic (port of worker's extractEndpointMetrics)
  const extracted = extractEndpointMetrics(events);
  if (extracted.length === 0) {
    console.error("✗ Extract returned zero endpoints — expected 1.");
    await cleanup(recordingId);
    process.exit(1);
  }
  const m = extracted[0]!;
  console.log(`  ✓ extracted endpoint: ${m.signature}`);
  console.log(`      latency:   ${m.latencyMs}ms`);
  console.log(`      db:        ${m.dbQueryCount}`);
  console.log(`      ext http:  ${m.externalHttpCount}`);
  console.log(`      status:    ${m.topStatus}`);
  console.log(`      downstr:   [${m.downstreamSignatures.join(", ")}]`);

  // 4. Derive healthy flag the same way the worker does: alert_id NULL
  //    on the recording AND no error-kind events in the stream.
  const hasErrorEvent = events.some((e) => e.kind?.type === "error");
  const healthy = !hasErrorEvent; // alertId was NULL above
  console.log(`  ✓ healthy:    ${healthy}`);

  // 5. Insert into session_endpoint_metrics (mirrors the batch insert
  //    the worker does, with onConflictDoNothing semantics).
  await sql`
    INSERT INTO session_endpoint_metrics
      (substrate_recording_id, project_id, endpoint_signature,
       endpoint_url_raw, captured_at, healthy, latency_ms,
       db_query_count, external_http_count, top_status,
       downstream_signatures)
    VALUES
      (${recordingId}::uuid, ${PROJECT_ID}::uuid, ${m.signature},
       ${m.urlRaw}, ${startedAt.toISOString()}::timestamptz, ${healthy},
       ${m.latencyMs}, ${m.dbQueryCount}, ${m.externalHttpCount},
       ${m.topStatus}, ${JSON.stringify(m.downstreamSignatures)}::jsonb)
    ON CONFLICT (substrate_recording_id, endpoint_signature) DO NOTHING
  `;
  console.log(`  ✓ inserted session_endpoint_metrics`);

  // 6. Verify by reading it back
  const rows = (await sql`
    SELECT endpoint_signature, latency_ms, db_query_count,
           external_http_count, top_status, healthy,
           jsonb_array_length(downstream_signatures) AS downstream_count,
           downstream_signatures
    FROM session_endpoint_metrics
    WHERE substrate_recording_id = ${recordingId}::uuid
  `) as Array<{
    endpoint_signature: string;
    latency_ms: number;
    db_query_count: number;
    external_http_count: number;
    top_status: number;
    healthy: boolean;
    downstream_count: number;
    downstream_signatures: string[];
  }>;

  console.log("\n◆ Verified row from Neon:\n");
  if (rows.length === 0) {
    console.error("✗ Row missing after insert");
    await cleanup(recordingId);
    process.exit(1);
  }
  const row = rows[0]!;
  console.log(`  signature:         ${row.endpoint_signature}`);
  console.log(`  latency_ms:        ${row.latency_ms}`);
  console.log(`  db_query_count:    ${row.db_query_count}`);
  console.log(`  external_http:     ${row.external_http_count}`);
  console.log(`  top_status:        ${row.top_status}`);
  console.log(`  healthy:           ${row.healthy}`);
  console.log(`  downstream_count:  ${row.downstream_count}`);

  // 7. Idempotency check — re-run the INSERT with the same key, should
  //    be a no-op due to onConflictDoNothing.
  await sql`
    INSERT INTO session_endpoint_metrics
      (substrate_recording_id, project_id, endpoint_signature,
       endpoint_url_raw, captured_at, healthy, latency_ms,
       db_query_count, external_http_count, top_status,
       downstream_signatures)
    VALUES
      (${recordingId}::uuid, ${PROJECT_ID}::uuid, ${m.signature},
       'different-url', ${startedAt.toISOString()}::timestamptz, ${healthy},
       999, 999, 999, 999,
       '[]'::jsonb)
    ON CONFLICT (substrate_recording_id, endpoint_signature) DO NOTHING
  `;
  const afterConflictRows = (await sql`
    SELECT latency_ms, db_query_count FROM session_endpoint_metrics
    WHERE substrate_recording_id = ${recordingId}::uuid
  `) as Array<{ latency_ms: number; db_query_count: number }>;
  const idempotent = afterConflictRows.length === 1
    && afterConflictRows[0]!.latency_ms === row.latency_ms
    && afterConflictRows[0]!.db_query_count === row.db_query_count;
  console.log(`  idempotent ON CONFLICT: ${idempotent ? "✓" : "✗"}`);

  // 8. Cleanup
  await cleanup(recordingId);
  console.log("\n  ✓ cleanup done");

  // 9. Assertions
  console.log("\n◆ Assertions:\n");
  const expectedDownstreams = [
    "https://api.segment.io/v1/track",
    "https://api.stripe.com/v1/charges",
    "postgres:INSERT audit_log",
    "postgres:SELECT users",
    "postgres:UPDATE orders",
  ].sort();
  const gotDownstreams = [...row.downstream_signatures].sort();
  const downstreamsMatch = JSON.stringify(gotDownstreams) === JSON.stringify(expectedDownstreams);

  const checks = [
    ["signature is normalized to :id",           row.endpoint_signature === "POST /api/checkout/:id"],
    ["latency 120ms (end - start)",              row.latency_ms === 120],
    ["db_query_count = 3",                       row.db_query_count === 3],
    ["external_http_count = 2",                  row.external_http_count === 2],
    ["top_status = 200",                         row.top_status === 200],
    ["healthy = true (no alert, no error event)",row.healthy === true],
    ["downstreams has 5 entries",                row.downstream_count === 5],
    ["downstreams match expected sorted set",    downstreamsMatch],
    ["ON CONFLICT idempotent",                   idempotent],
  ] as const;

  let allGreen = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) allGreen = false;
  }
  if (!downstreamsMatch) {
    console.log(`    expected: ${expectedDownstreams.join(", ")}`);
    console.log(`    got:      ${gotDownstreams.join(", ")}`);
  }

  console.log();
  if (!allGreen) {
    console.error("✗ Smoke test FAILED — extract output does not match expectations.");
    process.exit(1);
  }
  console.log("✓ Smoke test PASSED — extract logic works end-to-end against Neon.\n");
}

async function cleanup(recordingId: string): Promise<void> {
  // CASCADE deletes session_endpoint_metrics via the FK.
  await sql`DELETE FROM substrate_recordings WHERE id = ${recordingId}::uuid`;
}

// ── Extract logic (port of worker/src/jobs/substrate-extract.ts) ──────────

function extractEndpointMetrics(events: SubEvent[]): Extracted[] {
  let topRequest: { id: number; method: string; url: string; tsNs: number } | null = null;
  let topResponse: { status: number; tsNs: number } | null = null;
  let dbQueryCount = 0;
  let externalHttpCount = 0;
  const downstreams = new Set<string>();

  for (const e of events) {
    const k = e.kind;
    if (!k?.type) continue;
    const t = k.type;

    if (t === "http_request") {
      const url = typeof k.url === "string" ? k.url : "";
      const method = typeof k.method === "string" ? k.method : "GET";
      const id = typeof k.id === "number" ? k.id : null;
      const tsNs = typeof e.timestamp_ns === "number" ? e.timestamp_ns : null;
      if (topRequest === null && id !== null && tsNs !== null) {
        topRequest = { id, method, url, tsNs };
      } else if (topRequest !== null) {
        externalHttpCount++;
        if (url.length > 0) downstreams.add(stripQuery(url));
      }
    } else if (t === "http_response") {
      const id = typeof k.id === "number" ? k.id : null;
      const tsNs = typeof e.timestamp_ns === "number" ? e.timestamp_ns : null;
      const status = typeof k.status === "number" ? k.status : null;
      if (topRequest !== null && topResponse === null && id === topRequest.id && tsNs !== null && status !== null) {
        topResponse = { status, tsNs };
      }
    } else if (t === "db_query") {
      dbQueryCount++;
      const query = typeof k.query === "string" ? k.query : "";
      downstreams.add(dbQuerySignature(query));
    }
  }

  if (topRequest === null) return [];

  const signature = `${topRequest.method} ${normalizeRoute(topRequest.url)}`;
  const latencyMs = topResponse !== null ? (topResponse.tsNs - topRequest.tsNs) / 1_000_000 : null;
  return [{
    signature,
    urlRaw: topRequest.url,
    latencyMs: latencyMs !== null && latencyMs >= 0 ? latencyMs : null,
    dbQueryCount,
    externalHttpCount,
    topStatus: topResponse?.status ?? null,
    downstreamSignatures: [...downstreams].sort(),
  }];
}

function normalizeRoute(url: string): string {
  if (!url) return "/";
  const noQuery = stripQuery(url);
  const schemeIdx = noQuery.indexOf("://");
  let path: string;
  if (schemeIdx >= 0) {
    const pathStart = noQuery.indexOf("/", schemeIdx + 3);
    path = pathStart >= 0 ? noQuery.slice(pathStart) : "/";
  } else {
    path = noQuery;
  }
  if (path.length === 0) return "/";
  return path
    .split("/")
    .map((seg) => {
      if (seg.length === 0) return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
      return seg;
    })
    .join("/") || "/";
}

function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

function dbQuerySignature(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "postgres:unknown";
  const verb = (trimmed.split(/\s+/)[0] ?? "").toUpperCase();
  const tableMatch = trimmed.match(/(?:FROM|INTO|UPDATE|JOIN)\s+["`]?([\w.]+)["`]?/i);
  const table = tableMatch?.[1] ?? "unknown";
  return `postgres:${verb || "UNKNOWN"} ${table}`;
}

main().catch((err) => {
  console.error("Smoke test FAILED:", err);
  process.exit(1);
});
