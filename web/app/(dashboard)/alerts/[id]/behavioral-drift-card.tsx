"use client";

/**
 * Behavioral Drift card — VAR Gate 13.
 *
 * States: not-started → running → completed (pass / fail / insufficient) → failed.
 *
 * The completed state shows:
 *   - headline pass/fail chip + drifted_percent vs threshold
 *   - summary stats (analyzed / drifted / improved / insufficient_data)
 *   - max magnitude score as a secondary signal
 *   - drill-down lists:
 *     * drifted endpoints (red) with per-metric delta + structural flags
 *     * improvements (green) — yellow-light, never fails the gate
 *
 * Renders nothing when remediationId is null.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Info,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  GitBranch,
} from "lucide-react";

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

interface Run {
  runId: string;
  status: "running" | "completed" | "failed";
  windowDays: number;
  analyzedEndpoints: number;
  insufficientDataEndpoints: number;
  driftedEndpoints: number;
  improvedEndpoints: number;
  maxDriftScore: number | null;
  thresholdDriftedPercent: number;
  passed: boolean | null;
  endpointDetails: EndpointDrift[];
  improvementsDetected: EndpointDrift[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface BehavioralDriftCardProps {
  alertId: string;
  remediationId: string | null;
  remediationReady: boolean;
}

export function BehavioralDriftCard({
  alertId,
  remediationId,
  remediationReady,
}: BehavioralDriftCardProps) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDrifted, setShowDrifted] = useState(false);
  const [showImprovements, setShowImprovements] = useState(false);
  const pollRef = useRef<number | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/drift-analysis`);
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
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/drift-analysis`, {
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
          <Activity className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            Behavioral Drift
          </h3>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-fg-base/50">
          VAR Gate 13
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
        ) : run.passed === null ? (
          <InsufficientDataState run={run} />
        ) : (
          <CompletedState
            run={run}
            showDrifted={showDrifted}
            showImprovements={showImprovements}
            onToggleDrifted={() => setShowDrifted((v) => !v)}
            onToggleImprovements={() => setShowImprovements((v) => !v)}
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
      Loading drift analysis…
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
          the fix&apos;s replay I/O against the 7-day baseline of healthy
          production recordings to catch silent behavioural regressions.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-base/70">
        Compare fix vs 7-day historical baseline per endpoint. Gate fails
        when more than 20% of analyzed endpoints show drift (magnitude or
        structural). Improvements are surfaced separately and never fail.
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
            <Activity className="h-3 w-3" aria-hidden />
            Run drift analysis
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
      Scoring against 7-day baseline…
    </div>
  );
}

function InsufficientDataState({ run }: { run: Run }) {
  const insufficient = run.insufficientDataEndpoints;
  return (
    <div className="flex items-start gap-2 text-xs text-fg-base/70">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-base/50" aria-hidden />
      <p>
        {insufficient > 0
          ? `All ${insufficient} endpoint(s) touched by the fix have <50 healthy baseline samples in the last ${run.windowDays}d window. `
          : "No matching fleet replays or endpoints extracted. "}
        Gate 13 skipped — nothing to measure.
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
          <p className="font-medium">Drift analysis failed</p>
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
  showDrifted,
  showImprovements,
  onToggleDrifted,
  onToggleImprovements,
}: {
  run: Run;
  showDrifted: boolean;
  showImprovements: boolean;
  onToggleDrifted: () => void;
  onToggleImprovements: () => void;
}) {
  const passed = run.passed ?? false;
  const driftedPct =
    run.analyzedEndpoints > 0
      ? (run.driftedEndpoints / run.analyzedEndpoints) * 100
      : 0;
  const threshold = run.thresholdDriftedPercent;

  const tone = passed
    ? {
        bg: "bg-emerald-500/15",
        text: "text-emerald-600 dark:text-emerald-400",
        label: "Passes gate",
        Icon: CheckCircle2,
      }
    : {
        bg: "bg-red-500/15",
        text: "text-red-600 dark:text-red-400",
        label: "Drift detected",
        Icon: AlertTriangle,
      };

  return (
    <div className="space-y-3">
      {/* Headline */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone.bg} ${tone.text}`}
        >
          <tone.Icon className="h-3 w-3" aria-hidden />
          {tone.label}
        </span>
        <span className="text-[10px] text-fg-base/60">
          threshold {threshold}% / window {run.windowDays}d
        </span>
      </div>

      {/* Summary stats grid — 3 cols: analyzed, drifted, improved */}
      <div className="grid grid-cols-3 gap-2">
        <StatBox
          label="analyzed"
          value={run.analyzedEndpoints}
          sub={
            run.insufficientDataEndpoints > 0
              ? `+${run.insufficientDataEndpoints} skipped`
              : undefined
          }
        />
        <StatBox
          label="drifted"
          value={run.driftedEndpoints}
          sub={`${driftedPct.toFixed(1)}%`}
          tone={passed ? "neutral" : "bad"}
        />
        <StatBox
          label="improved"
          value={run.improvedEndpoints}
          tone={run.improvedEndpoints > 0 ? "good" : "neutral"}
        />
      </div>

      {/* Max magnitude score — secondary signal */}
      {run.maxDriftScore !== null && run.maxDriftScore > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-fg-base/70">
          <span className="text-fg-base/50">max magnitude:</span>
          <span
            className={`tabular-nums font-semibold ${
              run.maxDriftScore > 0.3
                ? "text-red-600 dark:text-red-400"
                : run.maxDriftScore > 0.1
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-fg-base/70"
            }`}
          >
            {(run.maxDriftScore * 100).toFixed(1)}%
          </span>
          <span className="text-fg-base/40">
            (structural drift not included)
          </span>
        </div>
      )}

      {/* Drill-downs */}
      {run.endpointDetails.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={onToggleDrifted}
            className="group inline-flex items-center gap-1 text-[11px] font-medium text-red-600 hover:underline dark:text-red-400"
          >
            {showDrifted ? "Hide" : "Show"} drifted endpoints (
            {run.endpointDetails.length})
            <ArrowRight
              className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </button>
          {showDrifted && <EndpointList items={run.endpointDetails} variant="drift" />}
        </div>
      )}

      {run.improvementsDetected.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={onToggleImprovements}
            className="group inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 hover:underline dark:text-emerald-400"
          >
            {showImprovements ? "Hide" : "Show"} improvements (
            {run.improvementsDetected.length})
            <ArrowRight
              className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </button>
          {showImprovements && (
            <EndpointList items={run.improvementsDetected} variant="improvement" />
          )}
        </div>
      )}
    </div>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────────

function StatBox({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: "neutral" | "good" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "bad"
        ? "text-red-600 dark:text-red-400"
        : "text-fg-strong";
  return (
    <div className="rounded-lg bg-surface-inner px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-base/60">
        {label}
      </div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${toneClass}`}>
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[10px] tabular-nums text-fg-base/50">
          {sub}
        </div>
      )}
    </div>
  );
}

function EndpointList({
  items,
  variant,
}: {
  items: EndpointDrift[];
  variant: "drift" | "improvement";
}) {
  const rowTint =
    variant === "drift" ? "bg-red-500/[0.04]" : "bg-emerald-500/[0.04]";
  return (
    <ul
      className={`rounded-lg border border-line/60 bg-surface-inner divide-y divide-line/60 text-[11px]`}
    >
      {items.map((ep) => (
        <li key={ep.signature} className={`px-3 py-2 space-y-1 ${rowTint}`}>
          <div className="flex items-center gap-2">
            <span
              className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase ${methodColor(
                ep.signature.split(" ")[0] ?? "",
              )}`}
            >
              {ep.signature.split(" ")[0]}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-fg-strong"
              title={ep.signature}
            >
              {ep.signature.split(" ").slice(1).join(" ")}
            </span>
            <span className="shrink-0 text-[9px] text-fg-base/40">
              n={ep.fixSamples} vs baseline {ep.baselineSamples}
            </span>
          </div>
          <MetricRow
            label="latency"
            delta={ep.magnitude.latencyMs}
            unit="ms"
            variant={variant}
          />
          <MetricRow
            label="db queries"
            delta={ep.magnitude.dbQueryCount}
            unit=""
            variant={variant}
          />
          <MetricRow
            label="external http"
            delta={ep.magnitude.externalHttpCount}
            unit=""
            variant={variant}
          />
          {ep.hasStructuralDrift && (
            <StructuralFlags structural={ep.structural} />
          )}
        </li>
      ))}
    </ul>
  );
}

function MetricRow({
  label,
  delta,
  unit,
  variant,
}: {
  label: string;
  delta: MetricDelta;
  unit: string;
  variant: "drift" | "improvement";
}) {
  if (delta.deltaPct === null) return null;
  const pct = delta.deltaPct * 100;
  const Trend = pct > 0 ? TrendingUp : TrendingDown;
  // Colour reflects direction, not magnitude — drift rows already tinted.
  const trendColor =
    variant === "improvement"
      ? "text-emerald-600 dark:text-emerald-400"
      : pct > 30
        ? "text-red-600 dark:text-red-400"
        : pct > 0
          ? "text-amber-600 dark:text-amber-400"
          : "text-emerald-600 dark:text-emerald-400";
  return (
    <div className="flex items-center gap-2 pl-5 text-[10px]">
      <span className="w-20 shrink-0 text-fg-base/50 tabular-nums">{label}</span>
      <span className="tabular-nums text-fg-base/70">
        {delta.baselineP95?.toFixed(1) ?? "—"}
        {unit} → {delta.fixP95?.toFixed(1) ?? "—"}
        {unit}
      </span>
      <span
        className={`ml-auto inline-flex items-center gap-0.5 tabular-nums ${trendColor}`}
      >
        <Trend className="h-2.5 w-2.5" aria-hidden />
        {pct > 0 ? "+" : ""}
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

function StructuralFlags({ structural }: { structural: StructuralDrift }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-5 text-[10px]">
      <GitBranch className="h-3 w-3 text-amber-500" aria-hidden />
      <span className="text-amber-600 dark:text-amber-400 font-medium">
        structural:
      </span>
      {structural.newDownstreams.length > 0 && (
        <span
          className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-700 dark:text-amber-300"
          title={structural.newDownstreams.join("\n")}
        >
          +{structural.newDownstreams.length} new downstream
        </span>
      )}
      {structural.missingDownstreams.length > 0 && (
        <span
          className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-700 dark:text-amber-300"
          title={structural.missingDownstreams.join("\n")}
        >
          −{structural.missingDownstreams.length} dropped
        </span>
      )}
      {structural.statusShift && (
        <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-700 dark:text-amber-300">
          5xx {(structural.statusShift.baseline5xxRatio * 100).toFixed(1)}% →{" "}
          {(structural.statusShift.fix5xxRatio * 100).toFixed(1)}%
        </span>
      )}
    </div>
  );
}

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
    case "POST":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "PUT":
    case "PATCH":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "DELETE":
      return "bg-red-500/15 text-red-600 dark:text-red-400";
    default:
      return "bg-fg-base/10 text-fg-base/70";
  }
}
