"use client";

/**
 * Multi-Environment Coverage card — VAR Gate 16.
 *
 * States: not-started → running → completed (pass / fail) / skipped / failed.
 *
 * completed-pass: green chip + coverage % + project vs fleet distribution
 *                 bars side-by-side. Medium misses shown as yellow chips
 *                 ("review 1 medium: node@16") — never fails the gate.
 *
 * completed-fail: red chip + list of HIGH-severity missing envs with
 *                 their project traffic % ("node@18 — 35% of traffic").
 *
 * skipped: informational panel. skipReason explains why the gate
 *          doesn't apply (single-env project, fleet still running, or
 *          no env data from Capture SDK).
 *
 * Renders nothing when remediationId is null.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Layers,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Info,
} from "lucide-react";

interface DistributionEntry {
  trafficPercent: number;
  sessionCount: number;
}

interface EnvVector {
  node: string | null;
  nodeMajor: number | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  sessionCount: number;
}

interface Run {
  runId: string;
  status: "running" | "completed" | "failed" | "skipped";
  windowDays: number;
  thresholdHighPercent: number;
  thresholdMediumPercent: number;
  projectEnvDistribution: Record<string, DistributionEntry>;
  fleetEnvDistribution: Record<string, DistributionEntry>;
  missingEnvsHigh: string[];
  missingEnvsMedium: string[];
  coveragePercent: number | null;
  observedEnvVectors: EnvVector[];
  passed: boolean | null;
  skipReason: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface MultiEnvCoverageCardProps {
  alertId: string;
  remediationId: string | null;
  remediationReady: boolean;
}

export function MultiEnvCoverageCard({
  alertId,
  remediationId,
  remediationReady,
}: MultiEnvCoverageCardProps) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/multi-env`);
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
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/multi-env`, {
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
          <Layers className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            Multi-Environment Coverage
          </h3>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-fg-base/50">
          VAR Gate 16
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
        ) : run.status === "skipped" ? (
          <SkippedState run={run} />
        ) : (
          <CompletedState run={run} />
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
      Loading multi-env coverage…
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
          the fleet replay env distribution (from Gate 12) against the
          project-wide Node runtime distribution — fails when a Node major
          with &gt;20% prod traffic was never exercised in the fleet replay.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-base/70">
        Check whether the fix was replayed against every Node major active
        in production. Requires Gate 12 to have completed.
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
            Scoring…
          </>
        ) : (
          <>
            <Layers className="h-3 w-3" aria-hidden />
            Run coverage scan
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
      Computing env distributions…
    </div>
  );
}

function SkippedState({ run }: { run: Run }) {
  const reasonText: Record<string, string> = {
    "single-env": `Project runs a single Node major — multi-env coverage is not meaningful.`,
    "fleet-incomplete": `Gate 12 (fleet verification) has not completed yet. Run it first, then retry.`,
    "no-project-data": `No alerts with env context in the last ${run.windowDays}d window. Update to Capture SDK v0.9+ so env vectors are emitted.`,
    "no-fleet-data": `Gate 12 completed but the replayed sessions had no env data attached.`,
  };
  const text = run.skipReason != null
    ? reasonText[run.skipReason] ?? `Gate skipped: ${run.skipReason}.`
    : "Gate skipped.";
  return (
    <div className="flex items-start gap-2 text-xs text-fg-base/70">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-base/50" aria-hidden />
      <p>{text}</p>
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
          <p className="font-medium">Coverage scan failed</p>
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

function CompletedState({ run }: { run: Run }) {
  const passed = run.passed ?? false;
  const tone = passed
    ? {
        bg: "bg-emerald-500/15",
        text: "text-emerald-600 dark:text-emerald-400",
        label: "Coverage passes",
        Icon: CheckCircle2,
      }
    : {
        bg: "bg-red-500/15",
        text: "text-red-600 dark:text-red-400",
        label: "Coverage gap",
        Icon: AlertTriangle,
      };

  // Sorted union of all env keys for side-by-side rendering.
  const allKeys = Array.from(
    new Set([
      ...Object.keys(run.projectEnvDistribution),
      ...Object.keys(run.fleetEnvDistribution),
    ]),
  ).sort((a, b) => {
    const tA = run.projectEnvDistribution[a]?.trafficPercent ?? 0;
    const tB = run.projectEnvDistribution[b]?.trafficPercent ?? 0;
    return tB - tA;
  });

  return (
    <div className="space-y-3">
      {/* Headline */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone.bg} ${tone.text}`}>
          <tone.Icon className="h-3 w-3" aria-hidden />
          {tone.label}
        </span>
        <span className="text-[10px] text-fg-base/60">
          threshold &gt;{run.thresholdHighPercent}% HIGH, {run.thresholdMediumPercent}–{run.thresholdHighPercent}% medium
        </span>
        <span className="text-[10px] text-fg-base/60">
          window {run.windowDays}d
        </span>
      </div>

      {/* Coverage summary */}
      {run.coveragePercent !== null && (
        <div className="text-[11px] text-fg-base/70">
          <span className="text-fg-base/50">traffic covered:</span>{" "}
          <span className={`tabular-nums font-semibold ${
            passed ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
          }`}>
            {run.coveragePercent.toFixed(1)}%
          </span>
        </div>
      )}

      {/* Distribution comparison */}
      {allKeys.length > 0 && (
        <div className="rounded-lg border border-line/60 bg-surface-inner divide-y divide-line/60 text-[11px]">
          <div className="grid grid-cols-[auto_1fr_1fr] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wider text-fg-base/50">
            <span>env</span>
            <span>project</span>
            <span>fleet</span>
          </div>
          {allKeys.map((key) => {
            const p = run.projectEnvDistribution[key];
            const f = run.fleetEnvDistribution[key];
            const isHighMiss = run.missingEnvsHigh.includes(key);
            const isMediumMiss = run.missingEnvsMedium.includes(key);
            const rowTone = isHighMiss
              ? "bg-red-500/[0.04]"
              : isMediumMiss
                ? "bg-amber-500/[0.04]"
                : "";
            return (
              <div
                key={key}
                className={`grid grid-cols-[auto_1fr_1fr] gap-3 px-3 py-1.5 items-center ${rowTone}`}
              >
                <span className="font-mono text-fg-strong">{key}</span>
                <DistBar entry={p} tone="project" />
                <DistBar entry={f} tone={isHighMiss ? "miss-high" : isMediumMiss ? "miss-medium" : "fleet"} />
              </div>
            );
          })}
        </div>
      )}

      {/* Missing env chips */}
      {(run.missingEnvsHigh.length > 0 || run.missingEnvsMedium.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          {run.missingEnvsHigh.map((k) => (
            <span
              key={`h-${k}`}
              className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-700 dark:text-red-300 font-mono"
              title="Missing from fleet, >20% project traffic"
            >
              missing {k} ({(run.projectEnvDistribution[k]?.trafficPercent ?? 0).toFixed(1)}%)
            </span>
          ))}
          {run.missingEnvsMedium.map((k) => (
            <span
              key={`m-${k}`}
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300 font-mono"
              title="Missing from fleet, 10-20% project traffic — review"
            >
              review {k} ({(run.projectEnvDistribution[k]?.trafficPercent ?? 0).toFixed(1)}%)
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DistBar({
  entry,
  tone,
}: {
  entry: DistributionEntry | undefined;
  tone: "project" | "fleet" | "miss-high" | "miss-medium";
}) {
  if (!entry) {
    return <span className="text-[10px] text-fg-base/40">—</span>;
  }
  const pct = entry.trafficPercent;
  const barColor =
    tone === "miss-high"
      ? "bg-red-500/60"
      : tone === "miss-medium"
        ? "bg-amber-500/60"
        : tone === "project"
          ? "bg-inari-accent/50"
          : "bg-emerald-500/50";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded bg-line/60">
        <div
          className={`absolute inset-y-0 left-0 ${barColor}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className="tabular-nums text-fg-base/70">
        {pct.toFixed(1)}%
      </span>
      <span className="text-[9px] text-fg-base/40 tabular-nums">
        n={entry.sessionCount}
      </span>
    </div>
  );
}
