"use client";

/**
 * Fleet Verification card on the alert detail page — VAR Gate 12 UI.
 *
 * States this component renders (in order of likelihood):
 *
 *   1. "not started" — alert has a remediation but no fleet run row.
 *      Shows a primary CTA button to kick one off.
 *   2. "running"     — poll every 2s, show progress bar + running counts.
 *   3. "singleton"   — run completed with sessionsTotal=0. Friendly
 *      copy: "This fingerprint only appeared in one session; single-
 *      session verification covers you."
 *   4. "completed"   — summary gauge (matched/total), outcome breakdown,
 *      passesThreshold badge, drill-down modal for failing sessions.
 *   5. "failed"      — error message + retry button.
 *
 * The card is intentionally a client component: the polling loop + the
 * kick-off button both need state. The server component that mounts it
 * only hands over alertId + remediationId.
 *
 * Renders nothing when remediationId is null (no fix to verify).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlaskConical,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  ArrowRight,
  Users,
  Info,
} from "lucide-react";

// ── Types mirroring the service layer ──────────────────────────────────────

type Outcome = "matched" | "uncertain" | "would_not_prevent" | "errored";

interface SessionResultSummary {
  sessionId: string;
  outcome: Outcome;
  riskScore?: number;
  errorCode?: string;
  durationMs: number;
}

interface FleetRun {
  runId: string;
  status: "running" | "completed" | "failed";
  sessionsAttempted: number;
  sessionsTotal: number;
  countMatched: number;
  countUncertain: number;
  countWouldNotPrevent: number;
  countErrored: number;
  matchedPercent: number | null;
  passesThreshold: boolean;
  sessionResults: SessionResultSummary[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

// ── Props ─────────────────────────────────────────────────────────────────

export interface FleetVerificationCardProps {
  alertId: string;
  /** The latest merged remediation for this alert. When null, the card
   *  renders nothing — there's no fix to verify across the fleet. */
  remediationId: string | null;
  /** True when the remediation has reached a mergeable state. */
  remediationReady: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────

export function FleetVerificationCard({
  alertId,
  remediationId,
  remediationReady,
}: FleetVerificationCardProps) {
  const [run, setRun] = useState<FleetRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const pollRef = useRef<number | null>(null);

  // Initial fetch + polling while running.
  const fetchRun = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/fleet-verify`);
      if (!r.ok) {
        setError(`Load failed (${r.status})`);
        setLoading(false);
        return;
      }
      const data = (await r.json()) as { run: FleetRun | null };
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

  const handleStart = useCallback(async (): Promise<void> => {
    if (!remediationId) return;
    setStarting(true);
    setError(null);
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/fleet-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remediationId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        setError(body.error ?? `Start failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as { run: FleetRun };
      setRun(data.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setStarting(false);
    }
  }, [alertId, remediationId]);

  // Skip entirely when no remediation exists.
  if (!remediationId) return null;

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <FlaskConical className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden="true" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            Fleet Verification
          </h3>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-fg-base/50">
          VAR Gate 12
        </span>
      </div>

      <div className="px-4 py-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-fg-base/60">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Loading verification status…
          </div>
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
          <RunningState run={run} />
        ) : run.status === "failed" ? (
          <FailedState run={run} starting={starting} onRetry={handleStart} />
        ) : run.sessionsTotal === 0 ? (
          <SingletonState />
        ) : (
          <CompletedState run={run} onOpenModal={() => setShowModal(true)} />
        )}
      </div>

      {showModal && run && (
        <DrillDownModal run={run} onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}

// ── State views ────────────────────────────────────────────────────────────

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
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-base/50" aria-hidden="true" />
        <p>
          Available once the remediation reaches a mergeable state. Runs the fix against
          up to 100 sessions with the same error fingerprint to verify it prevents the
          issue fleet-wide.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-base/70">
        Run this fix against up to 100 other sessions with the same error fingerprint to verify it would prevent the issue for all of them.
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={starting}
        className="inline-flex items-center gap-1.5 rounded-md bg-inari-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {starting ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Starting…
          </>
        ) : (
          <>
            <FlaskConical className="h-3 w-3" aria-hidden="true" />
            Verify across fleet
          </>
        )}
      </button>
      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function RunningState({ run }: { run: FleetRun }) {
  const pct = run.sessionsTotal > 0
    ? Math.round((run.sessionsAttempted / run.sessionsTotal) * 100)
    : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-fg-base/70">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-inari-accent" aria-hidden="true" />
        <span>
          Running {run.sessionsAttempted}/{run.sessionsTotal} sessions…
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-inner">
        <div
          className="h-full rounded-full bg-inari-accent transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-3 text-[10px] text-fg-base/60">
        <OutcomeCount icon="check" count={run.countMatched} label="matched" />
        <OutcomeCount icon="question" count={run.countUncertain} label="uncertain" />
        <OutcomeCount icon="x" count={run.countWouldNotPrevent} label="would not prevent" />
        {run.countErrored > 0 && (
          <OutcomeCount icon="err" count={run.countErrored} label="errored" />
        )}
      </div>
    </div>
  );
}

function CompletedState({
  run,
  onOpenModal,
}: {
  run: FleetRun;
  onOpenModal: () => void;
}) {
  const passes = run.passesThreshold;
  const nonMatched =
    run.countUncertain + run.countWouldNotPrevent + run.countErrored;

  return (
    <div className="space-y-3">
      {/* Gauge + pass/fail headline */}
      <div className="flex items-center gap-4">
        <Gauge percent={run.matchedPercent ?? 0} passes={passes} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tabular-nums text-fg-strong">
              {run.countMatched}
              <span className="text-base text-fg-base/50">/{run.sessionsTotal}</span>
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                passes
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              }`}
            >
              {passes ? "Passes gate" : "Below threshold"}
            </span>
          </div>
          <p className="mt-1 text-xs text-fg-base/70">
            {passes
              ? `${run.matchedPercent}% of affected sessions are protected by this fix (≥90% required for auto-merge).`
              : `${run.matchedPercent ?? 0}% protected — auto-merge needs ≥90%. Review the failing sessions before merging manually.`}
          </p>
        </div>
      </div>

      {/* Outcome breakdown row */}
      <div className="flex items-center gap-3 text-[11px]">
        <OutcomeBadge tone="green" icon={CheckCircle2} count={run.countMatched} label="matched" />
        <OutcomeBadge tone="amber" icon={AlertTriangle} count={run.countUncertain} label="uncertain" />
        <OutcomeBadge tone="red" icon={XCircle} count={run.countWouldNotPrevent} label="would NOT prevent" />
        {run.countErrored > 0 && (
          <OutcomeBadge tone="neutral" icon={Info} count={run.countErrored} label="errored" />
        )}
      </div>

      {nonMatched > 0 && (
        <button
          type="button"
          onClick={onOpenModal}
          className="group inline-flex items-center gap-1 text-[11px] font-medium text-inari-accent hover:underline"
        >
          Review {nonMatched} non-matching session{nonMatched === 1 ? "" : "s"}
          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function SingletonState() {
  return (
    <div className="flex items-start gap-2 text-xs text-fg-base/70">
      <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-base/50" aria-hidden="true" />
      <p>
        This fingerprint only appeared in one session. Single-session
        What-If already covers you — no fleet verification needed.
      </p>
    </div>
  );
}

function FailedState({
  run,
  starting,
  onRetry,
}: {
  run: FleetRun;
  starting: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">Fleet verification failed</p>
          {run.error && <p className="mt-0.5 text-fg-base/70">{run.error}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={starting}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-inner px-2 py-1 text-[11px] font-medium text-fg-base/80 transition-colors hover:border-inari-accent/40 hover:text-fg-strong disabled:opacity-60"
      >
        {starting ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Retrying…
          </>
        ) : (
          "Retry"
        )}
      </button>
    </div>
  );
}

// ── Primitives ────────────────────────────────────────────────────────────

function Gauge({ percent, passes }: { percent: number; passes: boolean }) {
  const R = 28;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - percent / 100);
  const stroke = passes ? "stroke-emerald-500" : "stroke-amber-500";
  return (
    <svg
      viewBox="0 0 72 72"
      className="h-16 w-16 shrink-0 -rotate-90"
      aria-label={`${percent}% matched`}
    >
      <circle cx={36} cy={36} r={R} strokeWidth={6} className="fill-none stroke-line" />
      <circle
        cx={36}
        cy={36}
        r={R}
        strokeWidth={6}
        strokeLinecap="round"
        className={`fill-none ${stroke}`}
        strokeDasharray={C}
        strokeDashoffset={offset}
      />
    </svg>
  );
}

function OutcomeBadge({
  tone,
  icon: Icon,
  count,
  label,
}: {
  tone: "green" | "amber" | "red" | "neutral";
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  count: number;
  label: string;
}) {
  const classes = {
    green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    red: "bg-red-500/10 text-red-600 dark:text-red-400",
    neutral: "bg-fg-base/10 text-fg-base/70",
  }[tone];
  return (
    <div className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${classes}`}>
      <Icon className="h-3 w-3" aria-hidden />
      <span className="font-semibold tabular-nums">{count}</span>
      <span className="text-[10px]">{label}</span>
    </div>
  );
}

function OutcomeCount({
  icon,
  count,
  label,
}: {
  icon: "check" | "question" | "x" | "err";
  count: number;
  label: string;
}) {
  const color = {
    check: "text-emerald-500",
    question: "text-amber-500",
    x: "text-red-500",
    err: "text-fg-base/60",
  }[icon];
  return (
    <span className="tabular-nums">
      <span className={`font-semibold ${color}`}>{count}</span>
      <span className="ml-1 text-fg-base/50">{label}</span>
    </span>
  );
}

function DrillDownModal({
  run,
  onClose,
}: {
  run: FleetRun;
  onClose: () => void;
}) {
  const nonMatching = run.sessionResults.filter((r) => r.outcome !== "matched");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h3 className="text-sm font-semibold text-fg-strong">
            Non-matching sessions ({nonMatching.length})
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-fg-base/60 hover:text-fg-strong"
          >
            Close
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {nonMatching.length === 0 ? (
            <p className="p-4 text-xs text-fg-base/60">No non-matching sessions.</p>
          ) : (
            <ul className="divide-y divide-line text-xs">
              {nonMatching.map((r) => (
                <li key={r.sessionId} className="flex items-start gap-3 px-4 py-2">
                  <OutcomePill outcome={r.outcome} />
                  <div className="min-w-0 flex-1">
                    <a
                      href={`/sessions/${encodeURIComponent(r.sessionId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-fg-strong hover:text-inari-accent hover:underline"
                    >
                      {r.sessionId}
                    </a>
                    {r.errorCode && (
                      <p className="mt-0.5 text-[10px] text-fg-base/60">{r.errorCode}</p>
                    )}
                  </div>
                  {r.riskScore !== undefined && (
                    <span className="tabular-nums text-[10px] text-fg-base/60">
                      risk {r.riskScore}/100
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function OutcomePill({ outcome }: { outcome: Outcome }) {
  const meta = {
    matched: { bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400", label: "MATCH" },
    uncertain: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400", label: "UNCERTAIN" },
    would_not_prevent: { bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400", label: "FAIL" },
    errored: { bg: "bg-fg-base/10", text: "text-fg-base/60", label: "ERROR" },
  }[outcome];
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${meta.bg} ${meta.text}`}
    >
      {meta.label}
    </span>
  );
}
