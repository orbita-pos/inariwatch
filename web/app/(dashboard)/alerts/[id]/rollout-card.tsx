"use client";

/**
 * Progressive Rollout card — VAR Q2 Week 12.
 *
 * States: not-started → pending/canary_1/canary_10/canary_50/full_100
 *         → complete | reverted | failed.
 *
 * UI:
 *   - Progress bar showing stages 1 → 10 → 50 → 100 with current
 *     position filled and color-coded (blue active, green complete,
 *     red reverted).
 *   - Advance button (when !canAdvance is false).
 *   - Rollback button with reason textarea (opens inline dialog).
 *   - Stage history table with per-stage start/end/duration/outcome.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Rocket,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Info,
  ChevronRight,
  Undo2,
} from "lucide-react";

type Stage =
  | "pending"
  | "canary_1"
  | "canary_10"
  | "canary_50"
  | "full_100"
  | "complete"
  | "reverted"
  | "failed";

interface StageHistoryEntry {
  stage: Stage;
  startedAt: string;
  endedAt: string | null;
  outcome: "advanced" | "reverted" | "running" | "completed";
  metrics: { newErrors?: number; uptimeFailures?: number; fingerprintRegressions?: number };
  triggeredBy: string | null;
}

interface Run {
  runId: string;
  currentStage: Stage;
  stageStartedAt: string;
  stageHistory: StageHistoryEntry[];
  autoRollbackEnabled: boolean;
  rollbackReason: string | null;
  rollbackPrUrl: string | null;
  status: "active" | "complete" | "reverted" | "failed";
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  canAdvance: boolean;
  nextStage: Stage | null;
}

const STAGE_ORDER: Stage[] = ["canary_1", "canary_10", "canary_50", "full_100"];
const STAGE_LABEL: Record<Stage, string> = {
  pending: "pending",
  canary_1: "1%",
  canary_10: "10%",
  canary_50: "50%",
  full_100: "100%",
  complete: "complete",
  reverted: "reverted",
  failed: "failed",
};

export interface RolloutCardProps {
  alertId: string;
  remediationId: string | null;
  remediationReady: boolean;
}

export function RolloutCard({ alertId, remediationId, remediationReady }: RolloutCardProps) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRollback, setShowRollback] = useState(false);
  const [rollbackReason, setRollbackReason] = useState("");
  const pollRef = useRef<number | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/rollout`);
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
    if (!run || run.status !== "active") {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = window.setInterval(fetchRun, 5000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [run, fetchRun]);

  const handleStart = useCallback(async () => {
    if (!remediationId) return;
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/rollout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", remediationId }),
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
      setWorking(false);
    }
  }, [alertId, remediationId]);

  const handleAdvance = useCallback(async () => {
    if (!run) return;
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/rollout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "advance", runId: run.runId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        setError(body.error ?? `Advance failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as { run: Run };
      setRun(data.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setWorking(false);
    }
  }, [alertId, run]);

  const handleRollback = useCallback(async () => {
    if (!run || rollbackReason.length < 3) return;
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/rollout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rollback",
          runId: run.runId,
          reason: rollbackReason,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        setError(body.error ?? `Rollback failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as { run: Run };
      setRun(data.run);
      setShowRollback(false);
      setRollbackReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setWorking(false);
    }
  }, [alertId, run, rollbackReason]);

  if (!remediationId) return null;

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Rocket className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            Progressive Rollout
          </h3>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-fg-base/50">
          VAR Week 12
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
            working={working}
            onStart={handleStart}
            error={error}
          />
        ) : (
          <ActiveState
            run={run}
            working={working}
            error={error}
            showRollback={showRollback}
            setShowRollback={setShowRollback}
            rollbackReason={rollbackReason}
            setRollbackReason={setRollbackReason}
            onAdvance={handleAdvance}
            onRollback={handleRollback}
          />
        )}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center gap-2 text-xs text-fg-base/60">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      Loading rollout…
    </div>
  );
}

function NotStartedState({
  remediationReady,
  working,
  onStart,
  error,
}: {
  remediationReady: boolean;
  working: boolean;
  onStart: () => void;
  error: string | null;
}) {
  if (!remediationReady) {
    return (
      <div className="flex items-start gap-2 text-xs text-fg-base/70">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-base/50" aria-hidden />
        <p>
          Available once the remediation reaches a mergeable state. Staged
          rollout at 1% → 10% → 50% → 100% with per-stage health checks and
          manual advance/rollback controls.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-base/70">
        Stage the fix through 1% → 10% → 50% → 100% traffic. Health checks
        from post-merge-monitor report into each stage; rollback is always
        one click away.
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={working}
        className="inline-flex items-center gap-1.5 rounded-md bg-inari-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {working ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Starting…
          </>
        ) : (
          <>
            <Rocket className="h-3 w-3" aria-hidden />
            Start rollout
          </>
        )}
      </button>
      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function ActiveState({
  run,
  working,
  error,
  showRollback,
  setShowRollback,
  rollbackReason,
  setRollbackReason,
  onAdvance,
  onRollback,
}: {
  run: Run;
  working: boolean;
  error: string | null;
  showRollback: boolean;
  setShowRollback: (v: boolean) => void;
  rollbackReason: string;
  setRollbackReason: (v: string) => void;
  onAdvance: () => void;
  onRollback: () => void;
}) {
  const isTerminal = run.status !== "active";
  const tone =
    run.status === "complete"
      ? {
          bg: "bg-emerald-500/15",
          text: "text-emerald-600 dark:text-emerald-400",
          label: "Rollout complete",
          Icon: CheckCircle2,
        }
      : run.status === "reverted"
        ? {
            bg: "bg-red-500/15",
            text: "text-red-600 dark:text-red-400",
            label: "Reverted",
            Icon: Undo2,
          }
        : run.status === "failed"
          ? {
              bg: "bg-red-500/15",
              text: "text-red-600 dark:text-red-400",
              label: "Failed",
              Icon: AlertTriangle,
            }
          : {
              bg: "bg-blue-500/15",
              text: "text-blue-600 dark:text-blue-400",
              label: `${STAGE_LABEL[run.currentStage]} in progress`,
              Icon: Rocket,
            };

  const activeIdx = STAGE_ORDER.indexOf(run.currentStage);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone.bg} ${tone.text}`}>
          <tone.Icon className="h-3 w-3" aria-hidden />
          {tone.label}
        </span>
        {run.autoRollbackEnabled && !isTerminal && (
          <span className="text-[10px] text-fg-base/60">auto-rollback armed</span>
        )}
      </div>

      {/* Stage progress bar */}
      <div className="flex items-center gap-1.5">
        {STAGE_ORDER.map((stage, idx) => {
          const reached = activeIdx >= idx || run.status === "complete";
          const current = activeIdx === idx && run.status === "active";
          const reverted = run.status === "reverted" && activeIdx === idx;
          const bg = reverted
            ? "bg-red-500"
            : reached
              ? run.status === "complete"
                ? "bg-emerald-500"
                : current
                  ? "bg-blue-500"
                  : "bg-emerald-500"
              : "bg-line/60";
          return (
            <div key={stage} className="flex items-center gap-1.5 flex-1">
              <div className="flex flex-col items-center gap-1 min-w-0 flex-1">
                <div className={`h-1.5 w-full rounded ${bg}`} />
                <span
                  className={`text-[10px] font-mono ${
                    current
                      ? "text-blue-600 dark:text-blue-400 font-semibold"
                      : "text-fg-base/60"
                  }`}
                >
                  {STAGE_LABEL[stage]}
                </span>
              </div>
              {idx < STAGE_ORDER.length - 1 && (
                <ChevronRight className="h-3 w-3 shrink-0 text-fg-base/30" aria-hidden />
              )}
            </div>
          );
        })}
      </div>

      {/* Rollback reason if reverted */}
      {run.status === "reverted" && run.rollbackReason && (
        <div className="rounded-md bg-red-500/[0.04] border border-red-500/20 px-3 py-2 text-[11px]">
          <div className="text-red-700 dark:text-red-300 font-medium">
            Reason for rollback
          </div>
          <div className="text-fg-base/70 mt-0.5">{run.rollbackReason}</div>
          {run.rollbackPrUrl && (
            <a
              href={run.rollbackPrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-[10px] text-inari-accent underline"
            >
              view revert PR
            </a>
          )}
        </div>
      )}

      {/* Action buttons */}
      {!isTerminal && !showRollback && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAdvance}
            disabled={working || !run.canAdvance}
            className="inline-flex items-center gap-1.5 rounded-md bg-inari-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {working ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden />
            )}
            {run.nextStage
              ? `Advance to ${STAGE_LABEL[run.nextStage]}`
              : "Advance"}
          </button>
          <button
            type="button"
            onClick={() => setShowRollback(true)}
            disabled={working}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-60"
          >
            <Undo2 className="h-3 w-3" aria-hidden />
            Rollback
          </button>
        </div>
      )}

      {/* Rollback dialog */}
      {showRollback && (
        <div className="rounded-md border border-red-500/30 bg-red-500/[0.04] px-3 py-2 space-y-2">
          <textarea
            value={rollbackReason}
            onChange={(e) => setRollbackReason(e.target.value)}
            rows={2}
            placeholder="Why are you rolling back? (min 3 chars)"
            className="w-full rounded border border-line bg-surface px-2 py-1 text-[11px] text-fg-strong outline-none focus:border-inari-accent"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRollback}
              disabled={working || rollbackReason.length < 3}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {working ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <Undo2 className="h-3 w-3" aria-hidden />
              )}
              Confirm rollback
            </button>
            <button
              type="button"
              onClick={() => {
                setShowRollback(false);
                setRollbackReason("");
              }}
              disabled={working}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg-base/70 hover:text-fg-strong disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}

      {/* Stage history drill-down */}
      {run.stageHistory.length > 1 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-fg-base/60 hover:text-fg-strong">
            History ({run.stageHistory.length} transitions)
          </summary>
          <ul className="mt-2 rounded-lg border border-line/60 bg-surface-inner divide-y divide-line/60">
            {run.stageHistory.map((h, i) => (
              <li
                key={i}
                className={`grid grid-cols-[auto_1fr_auto] gap-3 px-3 py-1.5 items-center ${
                  h.outcome === "reverted" ? "bg-red-500/[0.04]" : ""
                }`}
              >
                <span className="font-mono text-fg-strong">
                  {STAGE_LABEL[h.stage]}
                </span>
                <span className="text-fg-base/60 text-[10px] truncate">
                  {h.outcome}
                  {h.triggeredBy ? ` · ${h.triggeredBy}` : ""}
                </span>
                <span className="text-[10px] text-fg-base/40 tabular-nums">
                  {formatDuration(h.startedAt, h.endedAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function formatDuration(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
