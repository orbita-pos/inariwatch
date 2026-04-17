/**
 * Performance Benchmark — VAR Gate 17 ("Performance Regression").
 *
 * Measures whether a remediation's fix adds >N% latency to any critical
 * HTTP endpoint. Pure analysis on top of data Gate 12 already produced:
 * pulls recorded_events + replayed_events from whatif_replays, pairs
 * http_request/http_response events by correlation id, computes p50 + p99
 * per URL for both streams, reports per-URL regression.
 *
 * No new substrate runs, no clones. The job is fast (~100ms per alert)
 * so it can run inline in the low queue without tying up a worker.
 *
 * The gate's threshold is a policy choice: the job stores the raw
 * metrics + a boolean `passed` computed against a specific threshold.
 * If the workspace later bumps/drops the threshold, consumers read
 * `regression_percent` directly instead of trusting cached `passed`.
 */

import { eq, and } from "drizzle-orm";
import {
  db,
  alerts,
  remediationSessions,
  whatifReplays,
  performanceBenchmarks,
} from "../db.js";

const DEFAULT_THRESHOLD_PERCENT = 10;

export interface PerfJobInput {
  runId: string;
  /** Override default threshold (e.g. from per-project config). */
  thresholdPercent?: number;
}

// ── Substrate event shapes (subset we care about) ──────────────────────────

interface SubEvent {
  seq?: number;
  timestamp_ns?: number;
  kind?: {
    type?: string;
    id?: number;       // correlation id for http_request/http_response
    method?: string;
    url?: string;
    status?: number;
  };
}

interface PairStats {
  url: string;
  method: string;
  baselineP50Ms: number;
  fixP50Ms: number;
  regressionPct: number;
  sampleSize: number;
  slowerThanThreshold: boolean;
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function runPerformanceBenchmark({
  runId,
  thresholdPercent = DEFAULT_THRESHOLD_PERCENT,
}: PerfJobInput): Promise<void> {
  const [bench] = await db
    .select({
      id: performanceBenchmarks.id,
      alertId: performanceBenchmarks.alertId,
      remediationId: performanceBenchmarks.remediationId,
      fixCommitSha: performanceBenchmarks.fixCommitSha,
      status: performanceBenchmarks.status,
      thresholdPercent: performanceBenchmarks.thresholdPercent,
    })
    .from(performanceBenchmarks)
    .where(eq(performanceBenchmarks.id, runId))
    .limit(1);

  if (!bench) {
    console.warn(`[perf-benchmark] run ${runId} not found`);
    return;
  }
  if (bench.status !== "running") {
    console.log(`[perf-benchmark] ${runId} already ${bench.status}, skip`);
    return;
  }

  const threshold = bench.thresholdPercent ?? thresholdPercent;

  const [alert] = await db
    .select({ sessionId: alerts.sessionId })
    .from(alerts)
    .where(eq(alerts.id, bench.alertId))
    .limit(1);

  if (!alert?.sessionId) {
    await failBench(runId, "alert-has-no-session");
    return;
  }

  // The substrate events live in whatif_replays cached by (sessionId,
  // fixCommitSha). Gate 12 populated these; Gate 17 reads them.
  const [cache] = await db
    .select({ result: whatifReplays.result })
    .from(whatifReplays)
    .where(
      and(
        eq(whatifReplays.sessionId, alert.sessionId),
        eq(whatifReplays.fixCommitSha, bench.fixCommitSha),
      ),
    )
    .limit(1);

  if (!cache) {
    await failBench(runId, "no-whatif-cache");
    return;
  }

  const result = (cache.result ?? {}) as {
    substrate?: {
      recordedEvents?: SubEvent[];
      replayedEvents?: SubEvent[];
    };
  };
  const recorded = Array.isArray(result.substrate?.recordedEvents)
    ? result.substrate.recordedEvents
    : [];
  const replayed = Array.isArray(result.substrate?.replayedEvents)
    ? result.substrate.replayedEvents
    : [];

  if (recorded.length === 0 && replayed.length === 0) {
    // Singleton / AI-only what-if — nothing to benchmark. Mark the row
    // completed with null metrics so the UI renders "no HTTP paths" and
    // the auto-merge gate SKIPS (not fails).
    await db
      .update(performanceBenchmarks)
      .set({
        status: "completed",
        passed: null,
        completedAt: new Date(),
      })
      .where(eq(performanceBenchmarks.id, runId));
    return;
  }

  const baselineLatencies = latenciesByUrl(recorded);
  const fixLatencies = latenciesByUrl(replayed);

  const perUrl = compareByUrl(baselineLatencies, fixLatencies, threshold);

  const baselineAll = flatten(baselineLatencies);
  const fixAll = flatten(fixLatencies);
  const baselineP50 = percentile(baselineAll, 50);
  const baselineP99 = percentile(baselineAll, 99);
  const fixP50 = percentile(fixAll, 50);
  const fixP99 = percentile(fixAll, 99);
  const regression = baselineP50 !== null && baselineP50 > 0 && fixP50 !== null
    ? ((fixP50 - baselineP50) / baselineP50) * 100
    : null;

  const passed = regression === null ? null : regression <= threshold;

  await db
    .update(performanceBenchmarks)
    .set({
      status: "completed",
      baselineP50Ms: baselineP50,
      baselineP99Ms: baselineP99,
      fixP50Ms: fixP50,
      fixP99Ms: fixP99,
      regressionPercent: regression,
      affectedPaths: perUrl,
      passed,
      completedAt: new Date(),
    })
    .where(eq(performanceBenchmarks.id, runId));

  console.log(
    `[perf-benchmark] ${runId}: regression=${regression?.toFixed(2) ?? "n/a"}% passed=${passed ?? "n/a"} urls=${perUrl.length}`,
  );
}

async function failBench(runId: string, reason: string): Promise<void> {
  await db
    .update(performanceBenchmarks)
    .set({ status: "failed", completedAt: new Date(), error: reason })
    .where(eq(performanceBenchmarks.id, runId));
  console.error(`[perf-benchmark] ${runId} failed: ${reason}`);
}

// ── Pair http_request ↔ http_response by correlation id ───────────────────

/**
 * Return a map of `"METHOD url"` → sorted array of latencies in ms,
 * extracted by matching http_request and http_response events that
 * share a `kind.id` correlation value.
 *
 * Events with no `id` (unpaired probes or legacy SDK) are silently
 * dropped — we can't compute latency without the pair.
 */
function latenciesByUrl(events: SubEvent[]): Map<string, number[]> {
  const reqs = new Map<number, { method: string; url: string; tsNs: number }>();
  const pairs = new Map<string, number[]>();

  for (const e of events) {
    const k = e.kind;
    if (!k) continue;
    const t = k.type;
    const id = typeof k.id === "number" ? k.id : null;
    const tsNs = typeof e.timestamp_ns === "number" ? e.timestamp_ns : null;
    if (id === null || tsNs === null) continue;

    if (t === "http_request") {
      reqs.set(id, {
        method: typeof k.method === "string" ? k.method : "GET",
        url: typeof k.url === "string" ? k.url : "",
        tsNs,
      });
    } else if (t === "http_response") {
      const req = reqs.get(id);
      if (!req) continue;
      const latencyMs = (tsNs - req.tsNs) / 1_000_000;
      if (latencyMs < 0) continue; // clock skew or duplicate id — skip
      const key = `${req.method} ${normalizeUrl(req.url)}`;
      const arr = pairs.get(key) ?? [];
      arr.push(latencyMs);
      pairs.set(key, arr);
      reqs.delete(id);
    }
  }
  return pairs;
}

/** Strip query string so /api/foo?x=1 and /api/foo?x=2 group together. */
function normalizeUrl(url: string): string {
  const qIdx = url.indexOf("?");
  return qIdx >= 0 ? url.slice(0, qIdx) : url;
}

// ── Compare baseline vs fix per URL ───────────────────────────────────────

function compareByUrl(
  baseline: Map<string, number[]>,
  fix: Map<string, number[]>,
  threshold: number,
): PairStats[] {
  const urls = new Set<string>([...baseline.keys(), ...fix.keys()]);
  const out: PairStats[] = [];

  for (const urlKey of urls) {
    const b = baseline.get(urlKey) ?? [];
    const f = fix.get(urlKey) ?? [];
    if (b.length === 0 || f.length === 0) continue;
    const bP50 = percentile(b, 50)!;
    const fP50 = percentile(f, 50)!;
    const pct = bP50 > 0 ? ((fP50 - bP50) / bP50) * 100 : 0;
    const [method, ...urlParts] = urlKey.split(" ");
    out.push({
      method,
      url: urlParts.join(" "),
      baselineP50Ms: round2(bP50),
      fixP50Ms: round2(fP50),
      regressionPct: round2(pct),
      sampleSize: Math.min(b.length, f.length),
      slowerThanThreshold: pct > threshold,
    });
  }
  // Sort by regression desc — worst first so the UI truncation keeps
  // the most interesting rows.
  out.sort((a, b) => b.regressionPct - a.regressionPct);
  return out;
}

function flatten(m: Map<string, number[]>): number[] {
  const arr: number[] = [];
  for (const v of m.values()) arr.push(...v);
  return arr;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const copy = [...sorted].sort((a, b) => a - b);
  const idx = Math.min(copy.length - 1, Math.floor((p / 100) * copy.length));
  return round2(copy[idx]);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
