/**
 * Behavioral Drift — VAR Gate 13.
 *
 * Compares a fix's replayed I/O against the N-day rolling baseline of
 * HEALTHY production recordings. Per-endpoint permissive scoring:
 *   magnitude_score = max over metrics of max(0, (fix - baseline) / baseline)
 *   has_structural_drift = any set-diff on downstreams OR 5xx category shift
 *   endpoint counts as drifted when magnitude_score > 0.3 OR structural
 *   endpoint counts as improved when ALL metrics are directionally better
 *     AND no structural degradation
 * Gate passes when drifted_endpoints / analyzed_endpoints <= threshold
 *   (default 20%). Endpoints with under 50 baseline samples are marked
 *   insufficient_data and skipped.
 *
 * Source data:
 *   Fix's I/O       — whatif_replays.result.substrate.replayedEvents
 *     (one row per fleet session replayed, populated by Gate 12)
 *   Baseline        — session_endpoint_metrics raw samples (filled by
 *     substrate-extract at recordings/upload time), aggregated at query
 *     time via percentile_cont over a rolling window_days window with
 *     healthy=TRUE filter.
 *
 * The worker does NOT own baseline collection — that's substrate-extract's
 * job. This job is pure analysis on top.
 */

import { eq, sql } from "drizzle-orm";
import {
  db,
  alerts,
  behavioralDriftRuns,
  whatifReplays,
} from "../db.js";

const MIN_BASELINE_SAMPLES = 50;
const MAGNITUDE_FLAG_THRESHOLD = 0.3;
const IMPROVEMENT_THRESHOLD = 0.2;
const STATUS_SHIFT_THRESHOLD = 0.15;

export interface DriftJobInput {
  runId: string;
}

// ── Event + output shapes ─────────────────────────────────────────────────

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

interface MetricDelta {
  baselineP95: number | null;
  fixP95: number | null;
  deltaPct: number | null;
  flagged: boolean;
}

interface StructuralDrift {
  missingDownstreams: string[];
  newDownstreams: string[];
  statusShift: { baseline5xxRatio: number; fix5xxRatio: number } | null;
}

interface EndpointDrift {
  signature: string;
  magnitudeScore: number;
  hasStructuralDrift: boolean;
  baselineSamples: number;
  fixSamples: number;
  structural: StructuralDrift;
  magnitude: {
    latencyMs: MetricDelta;
    dbQueryCount: MetricDelta;
    externalHttpCount: MetricDelta;
  };
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function runBehavioralDrift({ runId }: DriftJobInput): Promise<void> {
  const [run] = await db
    .select()
    .from(behavioralDriftRuns)
    .where(eq(behavioralDriftRuns.id, runId))
    .limit(1);

  if (!run) {
    console.warn(`[drift] run ${runId} not found`);
    return;
  }
  if (run.status !== "running") {
    console.log(`[drift] ${runId} already ${run.status}, skip`);
    return;
  }

  // Resolve project from alert — baseline is project-scoped.
  const [alert] = await db
    .select({ projectId: alerts.projectId })
    .from(alerts)
    .where(eq(alerts.id, run.alertId))
    .limit(1);

  if (!alert?.projectId) {
    await failRun(runId, "alert-has-no-project");
    return;
  }
  const projectId = alert.projectId;

  // Gather the fix's I/O — every whatif_replays row for this fix sha.
  // Gate 12 populated these during fleet verification. We don't need
  // recordedEvents here (those are baseline-session snapshots, not our
  // historical baseline).
  const replays = await db
    .select({ result: whatifReplays.result })
    .from(whatifReplays)
    .where(eq(whatifReplays.fixCommitSha, run.fixCommitSha));

  if (replays.length === 0) {
    // No fleet replays yet — gate can't run. Mark completed with null
    // passed so auto-merge SKIPS (not fails), same as Gate 17's null path.
    await markSkipped(runId, "no-whatif-replays");
    return;
  }

  // Extract per-endpoint samples from every fleet replay, grouping by
  // signature so one endpoint collects samples across multiple replays.
  const fixSamplesByEndpoint = new Map<string, ExtractedSample[]>();
  for (const r of replays) {
    const result = (r.result ?? {}) as {
      substrate?: { replayedEvents?: SubEvent[] };
    };
    const events = Array.isArray(result.substrate?.replayedEvents)
      ? result.substrate.replayedEvents
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

  // Score each endpoint touched by the fix against its historical baseline.
  const driftDetails: EndpointDrift[] = [];
  const improvements: EndpointDrift[] = [];
  let analyzed = 0;
  let insufficientData = 0;
  let drifted = 0;
  let improved = 0;
  let maxMagnitudeScore = 0;

  for (const [signature, fixSamples] of fixSamplesByEndpoint.entries()) {
    const baseline = await queryBaseline(projectId, signature, run.windowDays);
    if (baseline.sampleCount < MIN_BASELINE_SAMPLES) {
      insufficientData++;
      continue;
    }
    analyzed++;

    const endpointDrift = scoreEndpoint(signature, baseline, fixSamples);
    maxMagnitudeScore = Math.max(maxMagnitudeScore, endpointDrift.magnitudeScore);

    const isDrifted =
      endpointDrift.magnitudeScore > MAGNITUDE_FLAG_THRESHOLD ||
      endpointDrift.hasStructuralDrift;
    const isImproved = detectImprovement(endpointDrift);

    if (isDrifted) {
      drifted++;
      driftDetails.push(endpointDrift);
    } else if (isImproved) {
      improved++;
      improvements.push(endpointDrift);
    }
  }

  // Gate decision — permissive calibration. Null when nothing analyzed
  // (auto-merge SKIPS null, same as Gate 17 contract).
  const driftedPercent = analyzed > 0 ? (drifted / analyzed) * 100 : 0;
  const passed =
    analyzed === 0 ? null : driftedPercent <= run.thresholdDriftedPercent;

  await db
    .update(behavioralDriftRuns)
    .set({
      status: "completed",
      analyzedEndpoints: analyzed,
      insufficientDataEndpoints: insufficientData,
      driftedEndpoints: drifted,
      improvedEndpoints: improved,
      maxDriftScore: analyzed > 0 ? maxMagnitudeScore : null,
      endpointDetails: driftDetails,
      improvementsDetected: improvements,
      passed,
      completedAt: new Date(),
    })
    .where(eq(behavioralDriftRuns.id, runId));

  console.log(
    `[drift] ${runId}: analyzed=${analyzed} drifted=${drifted} improved=${improved} insuf=${insufficientData} max=${maxMagnitudeScore.toFixed(3)} passed=${passed ?? "n/a"}`,
  );
}

// ── Event extraction (mirrors substrate-extract.ts logic) ─────────────────

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
      if (
        topRequest !== null &&
        topResponse === null &&
        id === topRequest.id &&
        tsNs !== null &&
        status !== null
      ) {
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
  const latencyMs =
    topResponse !== null ? (topResponse.tsNs - topRequest.tsNs) / 1_000_000 : null;

  return [
    {
      signature,
      urlRaw: topRequest.url,
      latencyMs: latencyMs !== null && latencyMs >= 0 ? latencyMs : null,
      dbQueryCount,
      externalHttpCount,
      topStatus: topResponse?.status ?? null,
      downstreamSignatures: downstreams,
    },
  ];
}

// ── Baseline query ────────────────────────────────────────────────────────

async function queryBaseline(
  projectId: string,
  signature: string,
  windowDays: number,
): Promise<Baseline> {
  // Two queries to avoid the jsonb_array_elements JOIN poisoning the
  // percentile aggregation (a single sample with 5 downstreams would
  // otherwise count as 5 rows in the percentile_cont input).
  const metrics = (await db.execute(sql`
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
  `)) as unknown as {
    rows: Array<{
      sample_count: number;
      latency_p95: number | null;
      latency_mean: number | null;
      db_query_mean: number | null;
      ext_http_mean: number | null;
      ratio_5xx: number | null;
    }>;
  };

  const row = metrics.rows[0];
  if (!row || row.sample_count === 0) {
    return {
      sampleCount: 0,
      latencyP95: null,
      latencyMean: null,
      dbQueryMean: null,
      externalHttpMean: null,
      ratio5xx: null,
      downstreams: new Set(),
    };
  }

  const downstreamRes = (await db.execute(sql`
    SELECT DISTINCT sig::text AS signature
    FROM session_endpoint_metrics,
         jsonb_array_elements_text(downstream_signatures) AS sig
    WHERE project_id = ${projectId}::uuid
      AND endpoint_signature = ${signature}
      AND captured_at > now() - (${windowDays}::text || ' days')::interval
      AND healthy = TRUE
  `)) as unknown as { rows: Array<{ signature: string }> };

  return {
    sampleCount: Number(row.sample_count),
    latencyP95: row.latency_p95,
    latencyMean: row.latency_mean,
    dbQueryMean: row.db_query_mean,
    externalHttpMean: row.ext_http_mean,
    ratio5xx: row.ratio_5xx,
    downstreams: new Set(downstreamRes.rows.map((r) => r.signature)),
  };
}

// ── Scoring ───────────────────────────────────────────────────────────────

function scoreEndpoint(
  signature: string,
  baseline: Baseline,
  fixSamples: ExtractedSample[],
): EndpointDrift {
  const fixLatencies = fixSamples
    .map((s) => s.latencyMs)
    .filter((v): v is number => v !== null);
  const fixDbCounts = fixSamples.map((s) => s.dbQueryCount);
  const fixExtCounts = fixSamples.map((s) => s.externalHttpCount);
  const fix5xx = fixSamples.filter(
    (s) => s.topStatus !== null && s.topStatus >= 500,
  ).length;
  const fix5xxRatio = fixSamples.length > 0 ? fix5xx / fixSamples.length : 0;

  const fixLatencyP95 = fixLatencies.length > 0 ? p95(fixLatencies) : null;
  const fixDbMean = mean(fixDbCounts);
  const fixExtMean = mean(fixExtCounts);

  const latencyDelta = computeDelta(baseline.latencyP95, fixLatencyP95);
  const dbQueryDelta = computeDelta(baseline.dbQueryMean, fixDbMean);
  const externalHttpDelta = computeDelta(baseline.externalHttpMean, fixExtMean);

  // Structural — set-diff on downstreams.
  const fixDownstreams = new Set<string>();
  for (const s of fixSamples) {
    for (const d of s.downstreamSignatures) fixDownstreams.add(d);
  }
  const missing = [...baseline.downstreams].filter(
    (d) => !fixDownstreams.has(d),
  );
  const added = [...fixDownstreams].filter((d) => !baseline.downstreams.has(d));

  // Status shift — 5xx category. If baseline had ~zero 5xx and fix has
  // more, that's drift. If baseline had many and fix has fewer, that's
  // improvement (evaluated in detectImprovement).
  const baseline5xx = baseline.ratio5xx ?? 0;
  const statusDelta = fix5xxRatio - baseline5xx;
  const statusShift =
    Math.abs(statusDelta) > STATUS_SHIFT_THRESHOLD
      ? { baseline5xxRatio: round4(baseline5xx), fix5xxRatio: round4(fix5xxRatio) }
      : null;

  const hasStructuralDrift =
    missing.length > 0 || added.length > 0 || (statusShift !== null && statusDelta > 0);

  // Magnitude score = max worsening delta across metrics, capped to 1.
  // Only POSITIVE deltas (fix is worse) contribute.
  const positiveDeltas = [latencyDelta, dbQueryDelta, externalHttpDelta]
    .map((d) => (d.deltaPct !== null && d.deltaPct > 0 ? d.deltaPct : 0));
  const magnitudeScore = Math.min(1, Math.max(0, ...positiveDeltas));

  return {
    signature,
    magnitudeScore: round4(magnitudeScore),
    hasStructuralDrift,
    baselineSamples: baseline.sampleCount,
    fixSamples: fixSamples.length,
    structural: {
      missingDownstreams: missing,
      newDownstreams: added,
      statusShift,
    },
    magnitude: {
      latencyMs: latencyDelta,
      dbQueryCount: dbQueryDelta,
      externalHttpCount: externalHttpDelta,
    },
  };
}

function computeDelta(
  baselineRef: number | null,
  fixRef: number | null,
): MetricDelta {
  if (baselineRef === null || fixRef === null || baselineRef === 0) {
    return {
      baselineP95: baselineRef,
      fixP95: fixRef,
      deltaPct: null,
      flagged: false,
    };
  }
  const deltaPct = (fixRef - baselineRef) / baselineRef;
  return {
    baselineP95: round4(baselineRef),
    fixP95: round4(fixRef),
    deltaPct: round4(deltaPct),
    flagged: deltaPct > MAGNITUDE_FLAG_THRESHOLD,
  };
}

/**
 * Improvement = all meaningful metrics directionally better AND no
 * structural degradation. "Better" means deltaPct <= -IMPROVEMENT_THRESHOLD
 * (20% lower is measurably better). If any metric has no baseline to
 * compare against (null deltaPct), it doesn't count against improvement.
 */
function detectImprovement(endpoint: EndpointDrift): boolean {
  if (endpoint.hasStructuralDrift) return false;
  const deltas = [
    endpoint.magnitude.latencyMs.deltaPct,
    endpoint.magnitude.dbQueryCount.deltaPct,
    endpoint.magnitude.externalHttpCount.deltaPct,
  ].filter((d): d is number => d !== null);
  if (deltas.length === 0) return false;
  // Every present delta must be negative enough; no positive deltas allowed.
  return deltas.every((d) => d <= -IMPROVEMENT_THRESHOLD);
}

// ── Stats helpers ─────────────────────────────────────────────────────────

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function p95(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return sorted[idx]!;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ── URL/query helpers (duplicated from substrate-extract for locality) ──

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
  const normalized = path
    .split("/")
    .map((seg) => {
      if (seg.length === 0) return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
        return ":id";
      }
      return seg;
    })
    .join("/");
  return normalized || "/";
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

// ── Failure paths ─────────────────────────────────────────────────────────

async function failRun(runId: string, reason: string): Promise<void> {
  await db
    .update(behavioralDriftRuns)
    .set({ status: "failed", completedAt: new Date(), error: reason })
    .where(eq(behavioralDriftRuns.id, runId));
  console.error(`[drift] ${runId} failed: ${reason}`);
}

async function markSkipped(runId: string, reason: string): Promise<void> {
  // Completed with null passed — auto-merge treats this as SKIP, not FAIL.
  // Consistent with Gate 17's null regressionPercent contract.
  await db
    .update(behavioralDriftRuns)
    .set({
      status: "completed",
      analyzedEndpoints: 0,
      insufficientDataEndpoints: 0,
      driftedEndpoints: 0,
      improvedEndpoints: 0,
      maxDriftScore: null,
      passed: null,
      completedAt: new Date(),
      error: reason,
    })
    .where(eq(behavioralDriftRuns.id, runId));
  console.log(`[drift] ${runId} skipped: ${reason}`);
}
