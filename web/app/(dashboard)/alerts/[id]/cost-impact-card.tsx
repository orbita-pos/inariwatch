"use client";

/**
 * Cost Impact card — VAR Gate 14.
 *
 * Aggregates AI spend from ai_usage_logs for this remediation and
 * shows it against the configured threshold. States: not-started /
 * running / completed (pass/fail) / skipped (no logs) / failed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DollarSign,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Info,
} from "lucide-react";

interface FeatureBreakdown {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

interface Run {
  runId: string;
  status: "running" | "completed" | "failed";
  remediationCostUsd: number;
  tokenCountInput: number;
  tokenCountOutput: number;
  tokenCountCached: number;
  callCount: number;
  costBreakdown: Record<string, FeatureBreakdown>;
  thresholdUsd: number;
  passed: boolean | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface CostImpactCardProps {
  alertId: string;
  remediationId: string | null;
  remediationReady: boolean;
}

export function CostImpactCard({
  alertId,
  remediationId,
  remediationReady,
}: CostImpactCardProps) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/cost-impact`);
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
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/cost-impact`, {
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
          <DollarSign className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            Cost Impact
          </h3>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-fg-base/50">
          VAR Gate 14
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
          <SkippedState run={run} />
        ) : (
          <CompletedState run={run} />
        )}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center gap-2 text-xs text-fg-base/60">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      Loading cost impact…
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
          Available once the remediation reaches a mergeable state. Aggregates AI
          spend (diagnose + self-review + security-scan + fix generation) and
          fails when the total exceeds the per-workspace budget.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-base/70">
        Compute total AI spend for this remediation vs the budget threshold
        (default $1.00).
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
            <DollarSign className="h-3 w-3" aria-hidden />
            Run cost check
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
      Aggregating ai_usage_logs…
    </div>
  );
}

function SkippedState({ run }: { run: Run }) {
  return (
    <div className="flex items-start gap-2 text-xs text-fg-base/70">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-base/50" aria-hidden />
      <p>
        No ai_usage_logs rows for this remediation. Likely BYOK with telemetry
        disabled — gate skipped. Threshold was ${run.thresholdUsd.toFixed(2)}.
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
          <p className="font-medium">Cost scan failed</p>
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
  const costPct = run.thresholdUsd > 0
    ? Math.min(100, (run.remediationCostUsd / run.thresholdUsd) * 100)
    : 0;

  const tone = passed
    ? {
        bg: "bg-emerald-500/15",
        text: "text-emerald-600 dark:text-emerald-400",
        label: "Within budget",
        Icon: CheckCircle2,
      }
    : {
        bg: "bg-red-500/15",
        text: "text-red-600 dark:text-red-400",
        label: "Over budget",
        Icon: AlertTriangle,
      };

  const features = Object.entries(run.costBreakdown).sort(
    (a, b) => b[1].costUsd - a[1].costUsd,
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone.bg} ${tone.text}`}>
          <tone.Icon className="h-3 w-3" aria-hidden />
          {tone.label}
        </span>
        <span className="text-[10px] text-fg-base/60">
          budget ${run.thresholdUsd.toFixed(2)}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3 items-center">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-base/50 mb-1">
            total cost
          </div>
          <div className={`text-2xl font-bold tabular-nums ${
            passed ? "text-fg-strong" : "text-red-600 dark:text-red-400"
          }`}>
            ${run.remediationCostUsd.toFixed(4)}
          </div>
          <div className="mt-0.5 text-[10px] text-fg-base/50 tabular-nums">
            {run.callCount} call{run.callCount === 1 ? "" : "s"} · {(run.tokenCountInput + run.tokenCountOutput).toLocaleString()} tokens
          </div>
        </div>
        {/* Budget usage bar */}
        <div className="w-24">
          <div className="text-[10px] tabular-nums text-fg-base/60 text-right mb-1">
            {costPct.toFixed(0)}%
          </div>
          <div className="relative h-1.5 overflow-hidden rounded bg-line/60">
            <div
              className={`absolute inset-y-0 left-0 ${
                passed ? "bg-emerald-500/60" : "bg-red-500/60"
              }`}
              style={{ width: `${costPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Per-feature breakdown */}
      {features.length > 0 && (
        <div className="rounded-lg border border-line/60 bg-surface-inner divide-y divide-line/60 text-[11px]">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wider text-fg-base/50">
            <span>feature</span>
            <span>cost</span>
            <span>tokens</span>
            <span>calls</span>
          </div>
          {features.map(([feature, b]) => (
            <div key={feature} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-1.5 items-center">
              <span className="font-mono text-fg-strong truncate">{feature}</span>
              <span className="tabular-nums text-fg-base/70">${b.costUsd.toFixed(4)}</span>
              <span className="tabular-nums text-fg-base/60 text-[10px]">
                {(b.inputTokens + b.outputTokens).toLocaleString()}
              </span>
              <span className="tabular-nums text-fg-base/50 text-[10px]">{b.callCount}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
