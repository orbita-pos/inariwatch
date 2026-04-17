/**
 * Smoke test — behavioral-drift job vs Neon.
 *
 * Runs the worker's drift scoring inline against the production Neon
 * DB (same connection string the web app uses). Exercises:
 *   - percentile_cont baseline SQL over 7d window
 *   - jsonb_array_elements_text downstream set query
 *   - permissive scoring (magnitude + structural)
 *   - UPDATE behavioral_drift_runs with computed result
 *
 * Prerequisite: scripts/seed-drift-demo.ts has been run (so the
 * 60 baseline samples + drift run row exist).
 *
 * Strategy:
 *   1. Reset the seeded behavioral_drift_runs row from "completed"
 *      back to "running" so the job will actually process it.
 *   2. Inject a synthetic whatif_replays row with replayedEvents that
 *      simulate the fix's I/O (6 fleet sessions, each with slightly
 *      different latency to give the fix-percentile a distribution).
 *   3. Run the exact scoring logic from
 *      worker/src/jobs/behavioral-drift.ts, inline here to avoid
 *      cross-package module resolution.
 *   4. Verify the result: analyzed=1 (only checkout has a baseline),
 *      drifted=1 (structural + magnitude), passed=false, max score > 0.
 *   5. Clean up the injected whatif_replays row.
 *
 * Usage:
 *   cd web && npx tsx scripts/smoke-test-drift.ts
 */

import { readFileSync } from "fs";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// ── Env + connection ─────────────────────────────────────────────────────

const env = readFileSync(".env.local", "utf-8");
const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
if (!match) {
  console.error("DATABASE_URL not found in .env.local");
  process.exit(1);
}
const sql = neon(match[1]);

// ── Constants from the seed ──────────────────────────────────────────────

const ALERT_ID = "d0e9e62e-b08e-4dd8-89ca-08ab142019ee";
const FIX_COMMIT_SHA = "d13f0001gate13demofixcommit000000000abcd";
const TEST_SESSION_PREFIX = "smoke-drift-";

// ── Types (mirror worker/src/jobs/behavioral-drift.ts) ────────────────────

const MIN_BASELINE_SAMPLES = 50;
const MAGNITUDE_FLAG_THRESHOLD = 0.3;
const IMPROVEMENT_THRESHOLD = 0.2;
const STATUS_SHIFT_THRESHOLD = 0.15;

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

interface ExtractedSample {
  signature: string;
  urlRaw: string;
  latencyMs: number | null;
  dbQueryCount: number;
  externalHttpCount: number;
  topStatus: number | null;
  downstreamSignatures: Set<string>;
}

interface Baseline {
  sampleCount: number;
  latencyP95: number | null;
  latencyMean: number | null;
  dbQueryMean: number | null;
  externalHttpMean: number | null;
  ratio5xx: number | null;
  downstreams: Set<string>;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n◆ Smoke test: behavioral-drift vs Neon\n");

  // 1. Find the seeded run id + project id
  const runRows = (await sql`
    SELECT bdr.id AS run_id, bdr.remediation_id, bdr.window_days,
           bdr.threshold_drifted_percent, a.project_id
    FROM behavioral_drift_runs bdr
    JOIN alerts a ON a.id = bdr.alert_id
    WHERE bdr.alert_id = ${ALERT_ID}::uuid
  `) as Array<{
    run_id: string;
    remediation_id: string;
    window_days: number;
    threshold_drifted_percent: number;
    project_id: string;
  }>;
  if (runRows.length === 0) {
    console.error("No drift run found — run seed-drift-demo.ts first.");
    process.exit(1);
  }
  const run = runRows[0];
  console.log(`  run id:      ${run.run_id}`);
  console.log(`  project id:  ${run.project_id}`);
  console.log(`  window:      ${run.window_days}d`);
  console.log(`  threshold:   ${run.threshold_drifted_percent}%\n`);

  // 2. Reset the row so the job will process it
  await sql`
    UPDATE behavioral_drift_runs
    SET status = 'running', passed = NULL,
        analyzed_endpoints = 0, drifted_endpoints = 0,
        improved_endpoints = 0, insufficient_data_endpoints = 0,
        max_drift_score = NULL,
        endpoint_details = '[]'::jsonb,
        improvements_detected = '[]'::jsonb,
        completed_at = NULL,
        error = NULL
    WHERE id = ${run.run_id}::uuid
  `;
  console.log("  ✓ reset run to 'running'");

  // 3. Clean up any prior smoke test injections
  await sql`DELETE FROM whatif_replays WHERE session_id LIKE ${TEST_SESSION_PREFIX + "%"}`;

  // 4. Inject 8 synthetic whatif_replays rows. Each one simulates a
  //    fleet session's replay of the fix code — the first http_request
  //    is the endpoint, latency varies per session to give the fix
  //    percentile a distribution.
  const fixEvents = buildFleetReplays();
  const insertedReplays = [];
  for (let i = 0; i < fixEvents.length; i++) {
    const sessionId = `${TEST_SESSION_PREFIX}${i}`;
    await sql`
      INSERT INTO whatif_replays (session_id, fix_commit_sha, result)
      VALUES (
        ${sessionId},
        ${FIX_COMMIT_SHA},
        ${JSON.stringify({
          substrate: { replayedEvents: fixEvents[i], recordedEvents: [] },
        })}::jsonb
      )
    `;
    insertedReplays.push(sessionId);
  }
  console.log(`  ✓ injected ${insertedReplays.length} whatif_replays`);

  // 5. Run the drift scoring (inline port of worker's runBehavioralDrift)
  const result = await runDriftScoring(run.run_id, run.project_id, run.window_days, run.threshold_drifted_percent);

  // 6. Read back the updated row + verify
  console.log("\n◆ Result:\n");
  const verified = (await sql`
    SELECT status, passed, analyzed_endpoints, drifted_endpoints,
           improved_endpoints, insufficient_data_endpoints,
           max_drift_score, endpoint_details, improvements_detected
    FROM behavioral_drift_runs
    WHERE id = ${run.run_id}::uuid
  `) as Array<{
    status: string;
    passed: boolean | null;
    analyzed_endpoints: number;
    drifted_endpoints: number;
    improved_endpoints: number;
    insufficient_data_endpoints: number;
    max_drift_score: number | null;
    endpoint_details: unknown[];
    improvements_detected: unknown[];
  }>;
  const v = verified[0]!;
  console.log(`  status:         ${v.status}`);
  console.log(`  passed:         ${v.passed}`);
  console.log(`  analyzed:       ${v.analyzed_endpoints}`);
  console.log(`  drifted:        ${v.drifted_endpoints}`);
  console.log(`  improved:       ${v.improved_endpoints}`);
  console.log(`  insufficient:   ${v.insufficient_data_endpoints}`);
  console.log(`  max drift:      ${v.max_drift_score}`);
  console.log(`  detail rows:    ${(v.endpoint_details as unknown[]).length}`);
  console.log(`  improvements:   ${(v.improvements_detected as unknown[]).length}`);

  if (v.endpoint_details && (v.endpoint_details as unknown[]).length > 0) {
    console.log("\n  ◈ First drifted endpoint:");
    console.log(JSON.stringify((v.endpoint_details as unknown[])[0], null, 2).split("\n").map(l => "    " + l).join("\n"));
  }

  // 7. Cleanup
  await sql`DELETE FROM whatif_replays WHERE session_id LIKE ${TEST_SESSION_PREFIX + "%"}`;
  console.log("\n  ✓ cleanup done");

  // 8. Assertions
  console.log("\n◆ Assertions:\n");
  const checks = [
    ["status=completed",           v.status === "completed"],
    ["analyzed = 1",               v.analyzed_endpoints === 1],
    ["drifted = 1",                v.drifted_endpoints === 1],
    ["insufficient = 0",           v.insufficient_data_endpoints === 0],
    ["max_drift_score > 0",        (v.max_drift_score ?? 0) > 0],
    ["passed = false",             v.passed === false],
    ["endpoint_details has 1 row", (v.endpoint_details as unknown[]).length === 1],
  ] as const;
  let allGreen = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) allGreen = false;
  }
  console.log();
  if (!allGreen) {
    console.error("✗ Smoke test FAILED — scoring output does not match expectations.");
    process.exit(1);
  }
  console.log("✓ Smoke test PASSED — scoring logic works end-to-end against Neon.\n");
}

// ── Fleet-replay event fixtures ──────────────────────────────────────────

/**
 * Build 8 fleet-session event streams. Each stream simulates one session
 * where the FIX code is replayed. First http_request is always
 * /api/checkout/order_X → endpoint signature POST /api/checkout/:id.
 * Downstream I/O mirrors baseline (3 db queries + stripe + segment) PLUS
 * a new external call to fraud.example.com (structural drift).
 * Latency spread: 140-160ms (baseline p95 was 110ms → should flag +42%).
 */
function buildFleetReplays(): SubEvent[][] {
  const sessions: SubEvent[][] = [];
  for (let i = 0; i < 8; i++) {
    // Purely numeric id so normalizeRoute collapses to :id and the
    // computed signature matches the baseline's "POST /api/checkout/:id".
    const orderId = `${3000 + i}`;
    const totalLatencyNs = (140 + i * 3) * 1_000_000; // 140ms, 143, 146, ... 161
    sessions.push([
      { seq: 1, timestamp_ns: 0,            kind: { type: "http_request",  id: 1, method: "POST", url: `/api/checkout/${orderId}` } },
      { seq: 2, timestamp_ns: 20_000_000,   kind: { type: "db_query",      id: 1, query: "SELECT * FROM users WHERE id = $1" } },
      { seq: 3, timestamp_ns: 35_000_000,   kind: { type: "db_query",      id: 2, query: "UPDATE orders SET status = $1" } },
      { seq: 4, timestamp_ns: 50_000_000,   kind: { type: "db_query",      id: 3, query: "INSERT INTO audit_log VALUES ($1)" } },
      { seq: 5, timestamp_ns: 60_000_000,   kind: { type: "http_request",  id: 2, method: "POST", url: "https://api.stripe.com/v1/charges" } },
      { seq: 6, timestamp_ns: 80_000_000,   kind: { type: "http_response", id: 2, status: 200 } },
      { seq: 7, timestamp_ns: 90_000_000,   kind: { type: "http_request",  id: 3, method: "POST", url: "https://api.segment.io/v1/track" } },
      { seq: 8, timestamp_ns: 100_000_000,  kind: { type: "http_response", id: 3, status: 200 } },
      { seq: 9, timestamp_ns: 110_000_000,  kind: { type: "http_request",  id: 4, method: "POST", url: "https://fraud.example.com/v1/check" } },
      { seq: 10, timestamp_ns: 125_000_000, kind: { type: "http_response", id: 4, status: 200 } },
      { seq: 11, timestamp_ns: totalLatencyNs, kind: { type: "http_response", id: 1, status: 200 } },
    ]);
  }
  return sessions;
}

// ── Drift scoring (port of worker/src/jobs/behavioral-drift.ts) ──────────

async function runDriftScoring(
  runId: string,
  projectId: string,
  windowDays: number,
  thresholdDriftedPercent: number,
): Promise<void> {
  // Load the fix's replays (every whatif_replays row for this fix sha).
  const replays = (await sql`
    SELECT result
    FROM whatif_replays
    WHERE fix_commit_sha = ${FIX_COMMIT_SHA}
  `) as Array<{ result: { substrate?: { replayedEvents?: SubEvent[] } } }>;

  if (replays.length === 0) {
    await markSkipped(runId, "no-whatif-replays");
    return;
  }

  const fixSamplesByEndpoint = new Map<string, ExtractedSample[]>();
  for (const r of replays) {
    const events = Array.isArray(r.result?.substrate?.replayedEvents)
      ? r.result.substrate.replayedEvents
      : [];
    if (events.length === 0) continue;
    const samples = extractEndpointSamples(events);
    for (const s of samples) {
      const bucket = fixSamplesByEndpoint.get(s.signature) ?? [];
      bucket.push(s);
      fixSamplesByEndpoint.set(s.signature, bucket);
    }
  }

  if (fixSamplesByEndpoint.size === 0) {
    await markSkipped(runId, "no-endpoints-in-replays");
    return;
  }

  const driftDetails: unknown[] = [];
  const improvements: unknown[] = [];
  let analyzed = 0;
  let insufficient = 0;
  let drifted = 0;
  let improved = 0;
  let maxMag = 0;

  for (const [signature, fixSamples] of fixSamplesByEndpoint.entries()) {
    const baseline = await queryBaseline(projectId, signature, windowDays);
    if (baseline.sampleCount < MIN_BASELINE_SAMPLES) {
      insufficient++;
      continue;
    }
    analyzed++;

    const score = scoreEndpoint(signature, baseline, fixSamples);
    maxMag = Math.max(maxMag, score.magnitudeScore);

    const isDrifted = score.magnitudeScore > MAGNITUDE_FLAG_THRESHOLD || score.hasStructuralDrift;
    const isImproved = detectImprovement(score);

    if (isDrifted) {
      drifted++;
      driftDetails.push(score);
    } else if (isImproved) {
      improved++;
      improvements.push(score);
    }
  }

  const driftedPercent = analyzed > 0 ? (drifted / analyzed) * 100 : 0;
  const passed = analyzed === 0 ? null : driftedPercent <= thresholdDriftedPercent;

  await sql`
    UPDATE behavioral_drift_runs
    SET status = 'completed',
        analyzed_endpoints = ${analyzed},
        insufficient_data_endpoints = ${insufficient},
        drifted_endpoints = ${drifted},
        improved_endpoints = ${improved},
        max_drift_score = ${analyzed > 0 ? maxMag : null},
        endpoint_details = ${JSON.stringify(driftDetails)}::jsonb,
        improvements_detected = ${JSON.stringify(improvements)}::jsonb,
        passed = ${passed},
        completed_at = now()
    WHERE id = ${runId}::uuid
  `;
}

function extractEndpointSamples(events: SubEvent[]): ExtractedSample[] {
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
    downstreamSignatures: downstreams,
  }];
}

async function queryBaseline(
  projectId: string,
  signature: string,
  windowDays: number,
): Promise<Baseline> {
  const metricsRows = (await sql`
    SELECT
      COUNT(*)::int AS sample_count,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS latency_p95,
      AVG(latency_ms)::double precision AS latency_mean,
      AVG(db_query_count)::double precision AS db_query_mean,
      AVG(external_http_count)::double precision AS ext_http_mean,
      (SUM(CASE WHEN top_status >= 500 THEN 1 ELSE 0 END))::double precision
        / NULLIF(COUNT(*), 0) AS ratio_5xx
    FROM session_endpoint_metrics
    WHERE project_id = ${projectId}::uuid
      AND endpoint_signature = ${signature}
      AND captured_at > now() - (${windowDays}::text || ' days')::interval
      AND healthy = TRUE
  `) as Array<{
    sample_count: number;
    latency_p95: number | null;
    latency_mean: number | null;
    db_query_mean: number | null;
    ext_http_mean: number | null;
    ratio_5xx: number | null;
  }>;

  const row = metricsRows[0];
  if (!row || row.sample_count === 0) {
    return { sampleCount: 0, latencyP95: null, latencyMean: null,
             dbQueryMean: null, externalHttpMean: null, ratio5xx: null,
             downstreams: new Set() };
  }

  const downstreamRes = (await sql`
    SELECT DISTINCT sig::text AS signature
    FROM session_endpoint_metrics,
         jsonb_array_elements_text(downstream_signatures) AS sig
    WHERE project_id = ${projectId}::uuid
      AND endpoint_signature = ${signature}
      AND captured_at > now() - (${windowDays}::text || ' days')::interval
      AND healthy = TRUE
  `) as Array<{ signature: string }>;

  return {
    sampleCount: Number(row.sample_count),
    latencyP95: row.latency_p95,
    latencyMean: row.latency_mean,
    dbQueryMean: row.db_query_mean,
    externalHttpMean: row.ext_http_mean,
    ratio5xx: row.ratio_5xx,
    downstreams: new Set(downstreamRes.map((r) => r.signature)),
  };
}

function scoreEndpoint(signature: string, baseline: Baseline, fixSamples: ExtractedSample[]) {
  const fixLat = fixSamples.map((s) => s.latencyMs).filter((v): v is number => v !== null);
  const fixDb = fixSamples.map((s) => s.dbQueryCount);
  const fixExt = fixSamples.map((s) => s.externalHttpCount);
  const fix5xx = fixSamples.filter((s) => s.topStatus !== null && s.topStatus >= 500).length;
  const fix5xxRatio = fixSamples.length > 0 ? fix5xx / fixSamples.length : 0;

  const fixLatP95 = fixLat.length > 0 ? p95(fixLat) : null;
  const fixDbMean = mean(fixDb);
  const fixExtMean = mean(fixExt);

  const latencyDelta = computeDelta(baseline.latencyP95, fixLatP95);
  const dbDelta = computeDelta(baseline.dbQueryMean, fixDbMean);
  const extDelta = computeDelta(baseline.externalHttpMean, fixExtMean);

  const fixDownstreams = new Set<string>();
  for (const s of fixSamples) for (const d of s.downstreamSignatures) fixDownstreams.add(d);
  const missing = [...baseline.downstreams].filter((d) => !fixDownstreams.has(d));
  const added = [...fixDownstreams].filter((d) => !baseline.downstreams.has(d));

  const baseline5xx = baseline.ratio5xx ?? 0;
  const statusDelta = fix5xxRatio - baseline5xx;
  const statusShift = Math.abs(statusDelta) > STATUS_SHIFT_THRESHOLD
    ? { baseline5xxRatio: round4(baseline5xx), fix5xxRatio: round4(fix5xxRatio) }
    : null;

  const hasStructuralDrift = missing.length > 0 || added.length > 0 || (statusShift !== null && statusDelta > 0);

  const positives = [latencyDelta, dbDelta, extDelta].map(
    (d) => (d.deltaPct !== null && d.deltaPct > 0 ? d.deltaPct : 0),
  );
  const magnitudeScore = Math.min(1, Math.max(0, ...positives));

  return {
    signature,
    magnitudeScore: round4(magnitudeScore),
    hasStructuralDrift,
    baselineSamples: baseline.sampleCount,
    fixSamples: fixSamples.length,
    structural: { missingDownstreams: missing, newDownstreams: added, statusShift },
    magnitude: { latencyMs: latencyDelta, dbQueryCount: dbDelta, externalHttpCount: extDelta },
  };
}

function computeDelta(bRef: number | null, fRef: number | null) {
  if (bRef === null || fRef === null || bRef === 0) {
    return { baselineP95: bRef, fixP95: fRef, deltaPct: null, flagged: false };
  }
  const deltaPct = (fRef - bRef) / bRef;
  return {
    baselineP95: round4(bRef),
    fixP95: round4(fRef),
    deltaPct: round4(deltaPct),
    flagged: deltaPct > MAGNITUDE_FLAG_THRESHOLD,
  };
}

function detectImprovement(endpoint: { hasStructuralDrift: boolean; magnitude: { latencyMs: { deltaPct: number | null }; dbQueryCount: { deltaPct: number | null }; externalHttpCount: { deltaPct: number | null } } }): boolean {
  if (endpoint.hasStructuralDrift) return false;
  const deltas = [
    endpoint.magnitude.latencyMs.deltaPct,
    endpoint.magnitude.dbQueryCount.deltaPct,
    endpoint.magnitude.externalHttpCount.deltaPct,
  ].filter((d): d is number => d !== null);
  if (deltas.length === 0) return false;
  return deltas.every((d) => d <= -IMPROVEMENT_THRESHOLD);
}

async function markSkipped(runId: string, reason: string): Promise<void> {
  await sql`
    UPDATE behavioral_drift_runs
    SET status = 'completed', analyzed_endpoints = 0, insufficient_data_endpoints = 0,
        drifted_endpoints = 0, improved_endpoints = 0, max_drift_score = NULL,
        passed = NULL, completed_at = now(), error = ${reason}
    WHERE id = ${runId}::uuid
  `;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function p95(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return sorted[idx]!;
}

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }

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
