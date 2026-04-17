"use client";

/**
 * Performance Benchmark card — VAR Gate 17.
 *
 * States: not-started → running → completed/failed.
 *
 * The completed state shows a side-by-side gauge (baseline p50 vs fix p50)
 * + regression percent + a collapsible per-URL breakdown. Singleton case
 * (no HTTP pairs found) shows "nothing to benchmark" without treating it
 * as a failure — that's the right outcome for a pure-DB service.
 *
 * Renders nothing when remediationId is null.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Gauge,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Info,
  ArrowRight,
  TrendingUp,
  TrendingDown,
} from "lucide-react";

interface AffectedPath {
  url: string;
  method: string;
  baselineP50Ms: number;
  fixP50Ms: number;
  regressionPct: number;
  sampleSize: number;
  slowerThanThreshold: boolean;
}

interface Run {
  runId: string;
  status: "running" | "completed" | "failed";
  baselineP50Ms: number | null;
  baselineP99Ms: number | null;
  fixP50Ms: number | null;
  fixP99Ms: number | null;
  regressionPercent: number | null;
  thresholdPercent: number;
  passed: boolean | null;
  affectedPaths: AffectedPath[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface PerformanceBenchmarkCardProps {
  alertId: string;
  remediationId: string | null;
  remediationReady: boolean;
}

export function PerformanceBenchmarkCard({
  alertId,
  remediationId,
  remediationReady,
}: PerformanceBenchmarkCardProps) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPaths, setShowPaths] = useState(false);
  const pollRef = useRef<number | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/performance-benchmark`);
      if (!r.ok) {
        setError(`Load failed (${r.status})`);
        setLoading(false);
        return;
      }
      const data = (await r.json()) as { run: Run | null };
      setRun(data.run);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setLoading(false);
    }
  }, [alertId]);

  useEffect(() => {
    if (!remediationId) return;
    void fetchRun();
  }, [fetchRun, remediationId]);

  useEffect(() => {
    if (!run || run.status !== "running") {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = window.setInterval(fetchRun, 2000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [run, fetchRun]);

  const handleStart = useCallback(async () => {
    if (!remediationId) return;
    setStarting(true);
    setError(null);
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/performance-benchmark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remediationId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        setError(body.error ?? `Start failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as { run: Run };
      setRun(data.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setStarting(false);
    }
  }, [alertId, remediationId]);

  if (!remediationId) return null;

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Gauge className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            Performance Benchmark
          </h3>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-fg-base/50">
          VAR Gate 17
        </span>
      </div>

      <div className="px-4 py-3">
        {loading ? (
          <LoadingState />
        ) : error && !run ? (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : !run ? (
          <NotStartedState
            remediationReady={remediationReady}
            starting={starting}
            onStart={handleStart}
            error={error}
          />
        ) : run.status === "running" ? (
          <RunningState />
        ) : run.status === "failed" ? (
          <FailedState run={run} starting={starting} onRetry={handleStart} />
        ) : run.regressionPercent === null ? (
          <NoHttpState />
        ) : (
          <CompletedState
            run={run}
            showPaths={showPaths}
            onToggle={() => setShowPaths((v) => !v)}
          />
        )}
      </div>
    </div>
  );
}

// ── States ────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex items-center gap-2 text-xs text-fg-base/60">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      Loading benchmark…
    </div>
  );
}

function NotStartedState({
  remediationReady,
  starting,
  onStart,
  error,
}: {
  remediationReady: boolean;
  starting: boolean;
  onStart: () => void;
  error: string | null;
}) {
  if (!remediationReady) {
    return (
      <div className="flex items-start gap-2 text-xs text-fg-base/70">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-base/50" aria-hidden />
        <p>
          Available once the remediation reaches a mergeable state. Compares
          the fix's replayed latency against the original recording to catch
          &gt;10% critical-path slowdowns.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-base/70">
        Compare fix vs original latency per HTTP endpoint. Gate fails when
        any critical path slows down more than the threshold (default 10%).
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={starting}
        className="inline-flex items-center gap-1.5 rounded-md bg-inari-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {starting ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Starting…
          </>
        ) : (
          <>
            <Gauge className="h-3 w-3" aria-hidden />
            Run benchmark
          </>
        )}
      </button>
      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function RunningState() {
  return (
    <div className="flex items-center gap-2 text-xs text-fg-base/70">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-inari-accent" aria-hidden />
      Analyzing substrate event timings…
    </div>
  );
}

function NoHttpState() {
  return (
    <div className="flex items-start gap-2 text-xs text-fg-base/70">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-base/50" aria-hidden />
      <p>
        No HTTP request/response pairs in the substrate recording — this
        service doesn&apos;t expose measurable critical paths. Gate 17 skipped.
      </p>
    </div>
  );
}

function FailedState({
  run,
  starting,
  onRetry,
}: {
  run: Run;
  starting: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Benchmark failed</p>
          {run.error && <p className="mt-0.5 text-fg-base/70">{run.error}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={starting}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-inner px-2 py-1 text-[11px] font-medium text-fg-base/80 hover:border-inari-accent/40 hover:text-fg-strong disabled:opacity-60"
      >
        {starting ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        Retry
      </button>
    </div>
  );
}

function CompletedState({
  run,
  showPaths,
  onToggle,
}: {
  run: Run;
  showPaths: boolean;
  onToggle: () => void;
}) {
  const regression = run.regressionPercent ?? 0;
  const passed = run.passed ?? false;
  const threshold = run.thresholdPercent;
  const slowerPaths = run.affectedPaths.filter((p) => p.slowerThanThreshold);

  const tone = passed
    ? { bg: "bg-emerald-500/15", text: "text-emerald-600 dark:text-emerald-400", label: "Passes gate", Icon: CheckCircle2 }
    : { bg: "bg-red-500/15", text: "text-red-600 dark:text-red-400", label: "Regression detected", Icon: AlertTriangle };

  const TrendIcon = regression > 0 ? TrendingUp : TrendingDown;

  return (
    <div className="space-y-3">
      {/* Headline */}
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone.bg} ${tone.text}`}>
          <tone.Icon className="h-3 w-3" aria-hidden />
          {tone.label}
        </span>
        <span className="text-[10px] text-fg-base/60">
          threshold {threshold}%
        </span>
      </div>

      {/* p50 comparison */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface-inner px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-base/60">baseline p50</div>
          <div className="mt-1 text-xl font-bold tabular-nums text-fg-strong">
            {run.baselineP50Ms?.toFixed(1) ?? "—"}
            <span className="ml-1 text-xs text-fg-base/50">ms</span>
          </div>
          {run.baselineP99Ms !== null && (
            <div className="mt-0.5 text-[10px] text-fg-base/50 tabular-nums">
              p99: {run.baselineP99Ms.toFixed(1)} ms
            </div>
          )}
        </div>
        <div className="rounded-lg bg-surface-inner px-3 py-2.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
            <span className="text-fg-base/60">fix p50</span>
            <span className={`inline-flex items-center gap-0.5 ${regression > 0 ? "text-red-500" : "text-emerald-500"}`}>
              <TrendIcon className="h-3 w-3" aria-hidden />
              {regression > 0 ? "+" : ""}{regression.toFixed(1)}%
            </span>
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-fg-strong">
            {run.fixP50Ms?.toFixed(1) ?? "—"}
            <span className="ml-1 text-xs text-fg-base/50">ms</span>
          </div>
          {run.fixP99Ms !== null && (
            <div className="mt-0.5 text-[10px] text-fg-base/50 tabular-nums">
              p99: {run.fixP99Ms.toFixed(1)} ms
            </div>
          )}
        </div>
      </div>

      {/* Drill-down toggle */}
      {run.affectedPaths.length > 0 && (
        <button
          type="button"
          onClick={onToggle}
          className="group inline-flex items-center gap-1 text-[11px] font-medium text-inari-accent hover:underline"
        >
          {showPaths ? "Hide" : "Show"} per-endpoint breakdown ({run.affectedPaths.length})
          {slowerPaths.length > 0 && (
            <span className="rounded bg-red-500/10 px-1 text-[10px] text-red-600 dark:text-red-400">
              {slowerPaths.length} slower
            </span>
          )}
          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </button>
      )}

      {showPaths && (
        <ul className="rounded-lg border border-line/60 bg-surface-inner divide-y divide-line/60 text-[11px]">
          {run.affectedPaths.map((p) => (
            <li
              key={`${p.method} ${p.url}`}
              className={`flex items-center gap-2 px-3 py-1.5 ${p.slowerThanThreshold ? "bg-red-500/[0.04]" : ""}`}
            >
              <span className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase ${methodColor(p.method)}`}>
                {p.method}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-fg-strong" title={p.url}>
                {p.url}
              </span>
              <span className="tabular-nums text-fg-base/60">
                {p.baselineP50Ms}→{p.fixP50Ms}ms
              </span>
              <span className={`shrink-0 w-12 text-right tabular-nums ${
                p.regressionPct > run.thresholdPercent ? "text-red-600 dark:text-red-400"
                : p.regressionPct > 0 ? "text-amber-600 dark:text-amber-400"
                : "text-emerald-600 dark:text-emerald-400"
              }`}>
                {p.regressionPct > 0 ? "+" : ""}{p.regressionPct.toFixed(1)}%
              </span>
              <span className="shrink-0 text-[9px] text-fg-base/40">n={p.sampleSize}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":    return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
    case "POST":   return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "PUT":
    case "PATCH":  return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "DELETE": return "bg-red-500/15 text-red-600 dark:text-red-400";
    default:       return "bg-fg-base/10 text-fg-base/70";
  }
}
