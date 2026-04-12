"use client";

import { useState, useEffect, useRef, useTransition } from "react";
import {
  Wrench, Loader2, CheckCircle2, XCircle,
  ExternalLink, GitMerge, X, RotateCcw, ChevronDown, ChevronUp,
  Shield, Eye, Undo2,
} from "lucide-react";
import { startRemediation, approveRemediation, cancelRemediation } from "./remediation-actions";

type Step = {
  id:        string;
  type:      string;
  message:   string;
  status:    "running" | "completed" | "failed";
  timestamp: string;
};

type Gate = {
  name:   string;
  passed: boolean;
  reason: string;
};

type SelfReview = {
  score:          number;
  concerns:       string[];
  recommendation: "approve" | "flag" | "reject";
};

type MonitoringPoll = {
  elapsed: number;
  total:   number;
  status:  string;
  checks?: { sentry?: string; uptime?: string };
};

type SessionState = {
  sessionId:     string | null;
  status:        string;
  steps:         Step[];
  prUrl:         string | null;
  prNumber:      number | null;
  error:         string | null;
  confidence:    number | null;
  diffFiles:     { path: string; lines: number }[];
  warning:       string | null;
  selfReview:    SelfReview | null;
  gates:         Gate[] | null;
  mergeStrategy: "auto_merge" | "draft_pr" | null;
  monitoring:    MonitoringPoll | null;
  autoReverted:  { reason: string; revertPrUrl?: string } | null;
  autoMerged:    boolean;
};

export function RemediationPanel({
  alertId,
  hasAIKey,
  hasGitHub,
  isVercelOnly = false,
  existingSession,
}: {
  alertId:        string;
  hasAIKey:       boolean;
  hasGitHub:      boolean;
  isVercelOnly?:  boolean;
  existingSession?: { id: string; status: string; steps: unknown; prUrl: string | null; prNumber: number | null; error: string | null } | null;
}) {
  const [state, setState] = useState<SessionState>({
    sessionId:     existingSession?.id     ?? null,
    status:        existingSession?.status ?? "idle",
    steps:         (existingSession?.steps as Step[]) ?? [],
    prUrl:         existingSession?.prUrl    ?? null,
    prNumber:      existingSession?.prNumber ?? null,
    error:         existingSession?.error    ?? null,
    confidence:    null,
    diffFiles:     [],
    warning:       null,
    selfReview:    null,
    gates:         null,
    mergeStrategy: null,
    monitoring:    null,
    autoReverted:  null,
    autoMerged:    false,
  });
  const [expanded, setExpanded]      = useState(true);
  const [isPending, startTransition] = useTransition();
  const [merging, setMerging]        = useState(false);
  const eventSourceRef               = useRef<EventSource | null>(null);
  const stepsEndRef                  = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest step (only within the terminal container)
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [state.steps.length]);

  // Clean up EventSource on unmount
  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  // Reconnect if there's an active session
  useEffect(() => {
    if (existingSession && !["completed", "failed", "cancelled"].includes(existingSession.status)) {
      connectSSE(existingSession.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connectSSE(sessionId: string) {
    eventSourceRef.current?.close();
    const es = new EventSource(`/api/remediation/stream/${sessionId}`);
    eventSourceRef.current = es;

    es.addEventListener("restore", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({
        ...s,
        sessionId,
        status:   data.status,
        steps:    data.steps    ?? s.steps,
        prUrl:    data.prUrl    ?? s.prUrl,
        prNumber: data.prNumber ?? s.prNumber,
        error:    data.error    ?? s.error,
      }));
    });

    es.addEventListener("status", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({ ...s, status: data.status }));
    });

    es.addEventListener("step", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({ ...s, steps: data.steps }));
    });

    es.addEventListener("step_update", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({ ...s, steps: data.steps }));
    });

    es.addEventListener("ci_poll", () => {
      // Steps already show status — could expose time elapsed later
    });

    es.addEventListener("confidence", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({ ...s, confidence: data.score ?? data.level ?? null }));
    });

    es.addEventListener("diff", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({ ...s, diffFiles: data.files ?? [] }));
    });

    es.addEventListener("warning", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({ ...s, warning: data.message }));
    });

    es.addEventListener("self_review", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({ ...s, selfReview: data }));
    });

    es.addEventListener("gates", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({
        ...s,
        gates:         data.gates ?? null,
        mergeStrategy: data.strategy ?? null,
      }));
    });

    es.addEventListener("monitoring_poll", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({ ...s, monitoring: data }));
    });

    es.addEventListener("monitoring_result", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({
        ...s,
        // Defensive: monitoring_result may arrive without a prior monitoring_poll.
        monitoring: s.monitoring
          ? { ...s.monitoring, status: data.status }
          : { elapsed: 0, total: 0, status: data.status },
      }));
    });

    es.addEventListener("auto_revert", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({
        ...s,
        autoReverted: { reason: data.reason, revertPrUrl: data.revertPrUrl },
      }));
    });

    es.addEventListener("done", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({
        ...s,
        status:     data.status,
        prUrl:      data.prUrl      ?? s.prUrl,
        prNumber:   data.prNumber   ?? s.prNumber,
        error:      data.error      ?? s.error,
        autoMerged: data.autoMerged ?? s.autoMerged,
      }));
      es.close();
    });

    es.addEventListener("error", () => {
      // EventSource auto-reconnects; terminal states come via the "done" event
    });
  }

  function handleStart() {
    startTransition(async () => {
      const result = await startRemediation(alertId);
      if (result.error) {
        setState((s) => ({ ...s, status: "failed", error: result.error! }));
        return;
      }
      if (result.sessionId) {
        setState((s) => ({
          ...s,
          sessionId: result.sessionId!,
          status:    "analyzing",
          steps:     [],
          error:     null,
          prUrl:     null,
          prNumber:  null,
        }));
        connectSSE(result.sessionId);
      }
    });
  }

  async function handleApprove() {
    if (!state.sessionId) return;
    setMerging(true);
    const result = await approveRemediation(state.sessionId);
    if (result.error) {
      setState((s) => ({ ...s, error: result.error! }));
    } else {
      setState((s) => ({ ...s, status: "completed" }));
    }
    setMerging(false);
  }

  async function handleCancel() {
    if (!state.sessionId) return;
    await cancelRemediation(state.sessionId);
    setState((s) => ({ ...s, status: "cancelled" }));
    eventSourceRef.current?.close();
  }

  function handleRetry() {
    setState({
      sessionId: null, status: "idle", steps: [], prUrl: null, prNumber: null, error: null,
      confidence: null, diffFiles: [], warning: null, selfReview: null, gates: null,
      mergeStrategy: null, monitoring: null, autoReverted: null, autoMerged: false,
    });
    handleStart();
  }

  const isActive = !["idle", "completed", "failed", "cancelled", "proposing"].includes(state.status)
    || state.monitoring?.status === "watching";

  // ── Gate states ──────────────────────────────────────────────────────────────
  // Don't show panel if no AI key or no GitHub integration
  if (!hasGitHub) {
    return (
      <section
        aria-labelledby="remediation-heading"
        className="rounded-xl border border-line bg-surface overflow-hidden"
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <Wrench className="h-4 w-4 text-fg-base/60" aria-hidden="true" />
          <h2 id="remediation-heading" className="text-xs font-medium uppercase tracking-wider text-fg-base/70">
            AI Remediation
          </h2>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-fg-base">
            Connect a GitHub integration to enable automated fixes.
          </p>
        </div>
      </section>
    );
  }

  // ── Idle state ───────────────────────────────────────────────────────────────
  if (state.status === "idle") {
    return (
      <section
        aria-labelledby="remediation-heading"
        className="rounded-xl border border-cyan-500/30 bg-cyan-500/[0.04] overflow-hidden"
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-cyan-500/20">
          <Wrench className="h-4 w-4 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
          <h2 id="remediation-heading" className="text-xs font-medium uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
            AI Remediation
          </h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-fg-base">
            Let AI diagnose the error, generate a fix, verify it with CI, and create a pull request.
          </p>
          {isVercelOnly && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5">
              <p className="text-[13px] text-amber-700 dark:text-amber-300 leading-relaxed">
                <strong>Heads-up:</strong> This alert came from Vercel only. Build logs will be fetched automatically if available. For runtime errors, connecting{" "}
                <a href="/settings/integrations" className="underline hover:no-underline font-medium">Sentry</a>{" "}
                provides stack traces for more precise fixes.
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={handleStart}
            disabled={isPending}
            aria-busy={isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 dark:bg-cyan-500 dark:hover:bg-cyan-400 dark:text-cyan-950 disabled:opacity-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
          >
            {isPending
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <Wrench className="h-4 w-4" aria-hidden="true" />}
            Fix with AI
          </button>
        </div>
      </section>
    );
  }

  // ── Active / completed states ────────────────────────────────────────────────
  const sectionState =
    state.status === "completed"                              ? "completed"
    : state.status === "failed" || state.status === "cancelled" ? "failed"
    : state.status === "proposing"                             ? "proposing"
    : "active";

  const sectionStyles: Record<string, string> = {
    completed: "border-emerald-500/30 bg-emerald-500/[0.04]",
    failed:    "border-red-500/30 bg-red-500/[0.04]",
    proposing: "border-cyan-500/30 bg-cyan-500/[0.04]",
    active:    "border-blue-500/30 bg-blue-500/[0.04]",
  };

  const headerTextStyles: Record<string, string> = {
    completed: "text-emerald-700 dark:text-emerald-300",
    failed:    "text-red-700 dark:text-red-300",
    proposing: "text-cyan-700 dark:text-cyan-300",
    active:    "text-blue-700 dark:text-blue-300",
  };

  return (
    <section
      aria-labelledby="remediation-heading"
      aria-busy={isActive}
      className={`rounded-xl border overflow-hidden ${sectionStyles[sectionState]}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
        {isActive ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" aria-hidden="true" />
        ) : state.status === "completed" ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        ) : state.status === "proposing" ? (
          <GitMerge className="h-4 w-4 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
        ) : (
          <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden="true" />
        )}
        <h2 id="remediation-heading" className={`text-xs font-medium uppercase tracking-wider ${headerTextStyles[sectionState]}`}>
          AI Remediation
          {isActive && (
            <span className="ml-1.5 normal-case font-normal text-fg-base/70">
              — {formatStatus(state.status)}
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls="remediation-body"
          aria-label={expanded ? "Collapse remediation details" : "Expand remediation details"}
          className="ml-auto text-fg-base/60 hover:text-fg-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 rounded"
        >
          {expanded
            ? <ChevronUp className="h-4 w-4" aria-hidden="true" />
            : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>

      {expanded && (
        <div id="remediation-body" className="px-5 py-4 space-y-4">

          {/* Confidence badge */}
          {state.confidence !== null && (
            <div
              role="status"
              aria-label={`AI confidence ${state.confidence} percent`}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                state.confidence >= 80
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30"
                  : state.confidence >= 50
                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30"
                  : "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/30"
              }`}
            >
              <span aria-hidden="true">
                {state.confidence >= 80 ? "🟢" : state.confidence >= 50 ? "🟡" : "🔴"}
              </span>
              {state.confidence}% confidence
              {state.confidence < 50 && " — manual review required"}
              {state.confidence >= 50 && state.confidence < 80 && " — review carefully"}
            </div>
          )}

          {/* Live terminal */}
          {state.steps.length > 0 && (
            <div className="rounded-lg border border-line bg-surface-inner overflow-hidden">
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-dim border-b border-line-subtle">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/70"    aria-hidden="true" />
                <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" aria-hidden="true" />
                <span className="h-2.5 w-2.5 rounded-full bg-green-500/70"  aria-hidden="true" />
                <span className="ml-2 text-[10px] font-mono text-fg-base/60">inariwatch — remediation</span>
              </div>
              <div className="max-h-80 overflow-y-auto">
                <ul
                  role="log"
                  aria-live="polite"
                  aria-label="Remediation progress steps"
                  className="px-4 py-3 font-mono text-xs space-y-1.5"
                >
                  {state.steps.map((step, i) => {
                    const isLast  = i === state.steps.length - 1;
                    const prefix  = step.status === "completed" ? "✓"
                                  : step.status === "failed"    ? "✗"
                                  : "›";
                    const prefixColor = step.status === "completed" ? "text-emerald-600 dark:text-emerald-400"
                                      : step.status === "failed"    ? "text-red-600 dark:text-red-400"
                                      : "text-blue-600 dark:text-blue-400";
                    const textColor   = step.status === "failed" ? "text-red-700 dark:text-red-400" : "text-fg-strong";

                    return (
                      <li key={step.id} className="flex items-start gap-2">
                        <span className={`shrink-0 ${prefixColor}`} aria-hidden="true">{prefix}</span>
                        <span className={`${textColor} leading-relaxed`}>
                          <span className="sr-only">
                            {step.status === "completed" ? "Completed: "
                              : step.status === "failed" ? "Failed: "
                              : "Running: "}
                          </span>
                          {step.message}
                          {isLast && step.status === "running" && (
                            <span className="inline-block w-1.5 h-3.5 bg-blue-600 dark:bg-blue-400 ml-1 animate-pulse" aria-hidden="true" />
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div ref={stepsEndRef} aria-hidden="true" />
              </div>
            </div>
          )}

          {/* Warning (blocked files) */}
          {state.warning && (
            <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <p className="text-xs text-amber-700 dark:text-amber-300">
                <span aria-hidden="true">⚠️ </span>{state.warning}
              </p>
            </div>
          )}

          {/* Diff preview */}
          {state.diffFiles.length > 0 && (
            <div className="rounded-lg border border-line bg-surface-inner overflow-hidden">
              <div className="px-3 py-1.5 bg-surface-dim border-b border-line-subtle">
                <h3 className="text-[10px] font-mono text-fg-base/70 uppercase tracking-wider">Files changed</h3>
              </div>
              <ul className="px-4 py-2.5 font-mono text-xs space-y-1">
                {state.diffFiles.map((f) => (
                  <li key={f.path} className="flex items-center gap-2">
                    <span className="text-amber-700 dark:text-amber-400" aria-hidden="true">M</span>
                    <span className="text-fg-strong">{f.path}</span>
                    <span className="text-fg-base/60 ml-auto">+{f.lines}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Self-review result */}
          {state.selfReview && (
            <div className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${
              state.selfReview.recommendation === "approve" ? "border-emerald-500/30 bg-emerald-500/5"
              : state.selfReview.recommendation === "reject" ? "border-red-500/30 bg-red-500/5"
              : "border-amber-500/30 bg-amber-500/5"
            }`}>
              <div className="flex items-center gap-2">
                <Eye className="h-3.5 w-3.5 text-fg-base" aria-hidden="true" />
                <p className="text-xs font-medium text-fg-strong">
                  Self-review: {state.selfReview.score}/100 — {state.selfReview.recommendation}
                </p>
              </div>
              {state.selfReview.concerns.length > 0 && (
                <ul className="text-xs text-fg-base space-y-0.5 ml-5">
                  {state.selfReview.concerns.map((c, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span aria-hidden="true">•</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Gate results */}
          {state.gates && (
            <div className="rounded-lg border border-line bg-surface-inner overflow-hidden">
              <div className="px-3 py-1.5 bg-surface-dim border-b border-line-subtle flex items-center gap-2">
                <Shield className="h-3 w-3 text-fg-base/60" aria-hidden="true" />
                <h3 className="text-[10px] font-mono text-fg-base/70 uppercase tracking-wider">
                  Safety gates — {state.mergeStrategy === "auto_merge" ? "Auto-merge" : "Draft PR"}
                </h3>
              </div>
              <ul className="px-4 py-2.5 font-mono text-xs space-y-1">
                {state.gates.map((gate) => (
                  <li key={gate.name} className="flex items-start gap-2">
                    <span
                      className={gate.passed ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}
                      aria-label={gate.passed ? "passed" : "failed"}
                    >
                      {gate.passed ? "✓" : "✗"}
                    </span>
                    <span className={gate.passed ? "text-fg-base" : "text-red-700 dark:text-red-400"}>
                      {gate.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Post-merge monitoring */}
          {state.monitoring && !state.autoReverted && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 space-y-2"
            >
              <div className="flex items-center gap-2">
                <Loader2
                  className={`h-3.5 w-3.5 text-blue-600 dark:text-blue-400 ${state.monitoring.status === "watching" ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
                  Post-merge monitoring — {Math.round(state.monitoring.elapsed)}s / {state.monitoring.total}s
                </p>
              </div>
              <div
                role="progressbar"
                aria-valuenow={Math.round((state.monitoring.elapsed / state.monitoring.total) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                className="w-full bg-line rounded-full h-1.5 overflow-hidden"
              >
                <div
                  className="bg-blue-500 h-full rounded-full transition-all duration-1000"
                  style={{ width: `${Math.min(100, (state.monitoring.elapsed / state.monitoring.total) * 100)}%` }}
                />
              </div>
              {state.monitoring.checks && (
                <div className="flex gap-4 text-xs">
                  {state.monitoring.checks.sentry && (
                    <span className={
                      state.monitoring.checks.sentry === "ok"
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-red-700 dark:text-red-400"
                    }>
                      Sentry: {state.monitoring.checks.sentry}
                    </span>
                  )}
                  {state.monitoring.checks.uptime && (
                    <span className={
                      state.monitoring.checks.uptime === "ok"
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-red-700 dark:text-red-400"
                    }>
                      Uptime: {state.monitoring.checks.uptime}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Auto-revert notification */}
          {state.autoReverted && (
            <div
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 space-y-2"
            >
              <div className="flex items-center gap-2">
                <Undo2 className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden="true" />
                <p className="text-sm text-red-700 dark:text-red-300 font-medium">Auto-reverted</p>
              </div>
              <p className="text-xs text-red-700 dark:text-red-400/80">
                Reason: {state.autoReverted.reason}
              </p>
              {state.autoReverted.revertPrUrl && (
                <a
                  href={state.autoReverted.revertPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 rounded-sm"
                >
                  View revert PR
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              )}
            </div>
          )}

          {/* Error message */}
          {state.error && state.status === "failed" && !state.autoReverted && (
            <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-red-700 dark:text-red-400">{state.error}</p>
            </div>
          )}

          {/* Proposing state — draft PR ready for review */}
          {state.status === "proposing" && state.prUrl && (
            <div className="space-y-3">
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-4 py-3 space-y-2">
                <p className="text-sm text-cyan-700 dark:text-cyan-300 font-medium">CI passes — Draft PR created</p>
                <p className="text-xs text-fg-base leading-relaxed">
                  This is a <strong className="text-fg-strong">draft PR</strong> — review all changes on GitHub before marking it ready to merge. It cannot be merged until you approve it.
                </p>
                <a
                  href={state.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-cyan-700 dark:text-cyan-400 hover:text-cyan-800 dark:hover:text-cyan-300 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 rounded-sm"
                >
                  Review Draft PR #{state.prNumber} on GitHub
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              </div>
              <div className="rounded-lg border border-line bg-surface-inner px-3 py-2.5">
                <p className="text-xs text-fg-base leading-relaxed">
                  On GitHub: review the diff → mark as ready → merge. We recommend enabling branch protection rules to require CI to pass before merging.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex items-center gap-2 rounded-lg border border-line-medium px-4 py-2 text-sm font-medium text-fg-base hover:text-fg-strong hover:border-line transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Dismiss
              </button>
            </div>
          )}

          {/* Completed state */}
          {state.status === "completed" && !state.autoReverted && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 space-y-1"
            >
              <p className="text-sm text-emerald-700 dark:text-emerald-400 font-medium">
                {state.autoMerged
                  ? "Fix auto-merged and monitoring passed. The alert has been resolved."
                  : "Fix merged successfully. The alert has been auto-resolved."}
              </p>
              {state.prUrl && (
                <a
                  href={state.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 rounded-sm"
                >
                  View merged PR
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              )}
            </div>
          )}

          {/* Failed / cancelled — retry button */}
          {(state.status === "failed" || state.status === "cancelled") && (
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center gap-2 rounded-lg border border-line-medium px-4 py-2 text-sm font-medium text-fg-base hover:text-fg-strong hover:border-line transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Try again
            </button>
          )}

          {/* Cancel button for active sessions */}
          {isActive && (
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex items-center gap-1.5 text-xs text-fg-base/70 hover:text-fg-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 rounded"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Cancel remediation
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function formatStatus(status: string): string {
  const map: Record<string, string> = {
    analyzing:      "analyzing error",
    reading_code:   "reading source code",
    generating_fix: "generating fix",
    pushing:        "pushing to GitHub",
    awaiting_ci:    "waiting for CI",
    proposing:      "ready for review",
    merging:        "auto-merging",
    monitoring:     "post-merge monitoring",
  };
  return map[status] ?? status;
}
