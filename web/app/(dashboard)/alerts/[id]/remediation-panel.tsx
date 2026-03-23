"use client";

import { useState, useEffect, useRef, useTransition } from "react";
import {
  Wrench, Loader2, CheckCircle2, XCircle, Clock,
  ExternalLink, GitMerge, X, RotateCcw, ChevronDown, ChevronUp,
  Shield, AlertTriangle, Eye, Undo2,
} from "lucide-react";
import { startRemediation, approveRemediation, cancelRemediation } from "./remediation-actions";

type Step = {
  id: string;
  type: string;
  message: string;
  status: "running" | "completed" | "failed";
  timestamp: string;
};

type Gate = {
  name: string;
  passed: boolean;
  reason: string;
};

type SelfReview = {
  score: number;
  concerns: string[];
  recommendation: "approve" | "flag" | "reject";
};

type MonitoringPoll = {
  elapsed: number;
  total: number;
  status: string;
  checks?: { sentry?: string; uptime?: string };
};

type SessionState = {
  sessionId: string | null;
  status: string;
  steps: Step[];
  prUrl: string | null;
  prNumber: number | null;
  error: string | null;
  confidence: number | null;
  diffFiles: { path: string; lines: number }[];
  warning: string | null;
  selfReview: SelfReview | null;
  gates: Gate[] | null;
  mergeStrategy: "auto_merge" | "draft_pr" | null;
  monitoring: MonitoringPoll | null;
  autoReverted: { reason: string; revertPrUrl?: string } | null;
  autoMerged: boolean;
};

const STEP_ICON: Record<string, React.ReactNode> = {
  running:   <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />,
  completed: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />,
  failed:    <XCircle className="h-3.5 w-3.5 text-red-400" />,
};

export function RemediationPanel({
  alertId,
  hasAIKey,
  hasGitHub,
  isVercelOnly = false,
  existingSession,
}: {
  alertId: string;
  hasAIKey: boolean;
  hasGitHub: boolean;
  isVercelOnly?: boolean;
  existingSession?: { id: string; status: string; steps: unknown; prUrl: string | null; prNumber: number | null; error: string | null } | null;
}) {
  const [state, setState] = useState<SessionState>({
    sessionId: existingSession?.id ?? null,
    status: existingSession?.status ?? "idle",
    steps: (existingSession?.steps as Step[]) ?? [],
    prUrl: existingSession?.prUrl ?? null,
    prNumber: existingSession?.prNumber ?? null,
    error: existingSession?.error ?? null,
    confidence: null,
    diffFiles: [],
    warning: null,
    selfReview: null,
    gates: null,
    mergeStrategy: null,
    monitoring: null,
    autoReverted: null,
    autoMerged: false,
  });
  const [expanded, setExpanded] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [merging, setMerging] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest step
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
        status: data.status,
        steps: data.steps ?? s.steps,
        prUrl: data.prUrl ?? s.prUrl,
        prNumber: data.prNumber ?? s.prNumber,
        error: data.error ?? s.error,
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
      // Could update a "time elapsed" indicator, but steps already show status
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
        gates: data.gates ?? null,
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
        monitoring: { ...s.monitoring!, status: data.status },
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
        status: data.status,
        prUrl: data.prUrl ?? s.prUrl,
        prNumber: data.prNumber ?? s.prNumber,
        error: data.error ?? s.error,
        autoMerged: data.autoMerged ?? s.autoMerged,
      }));
      es.close();
    });

    es.addEventListener("error", () => {
      // EventSource auto-reconnects, but if the server closed the stream it won't
      // We rely on the "done" event for terminal states
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
          status: "analyzing",
          steps: [],
          error: null,
          prUrl: null,
          prNumber: null,
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
    setState({ sessionId: null, status: "idle", steps: [], prUrl: null, prNumber: null, error: null, confidence: null, diffFiles: [], warning: null, selfReview: null, gates: null, mergeStrategy: null, monitoring: null, autoReverted: null, autoMerged: false });
    handleStart();
  }

  const isActive = !["idle", "completed", "failed", "cancelled", "proposing"].includes(state.status) || state.monitoring?.status === "watching";

  // Don't show panel if no AI key or no GitHub integration
  if (!hasAIKey || !hasGitHub) {
    return (
      <section className="rounded-xl border border-line bg-surface overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <Wrench className="h-4 w-4 text-zinc-500" />
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">AI Remediation</span>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-zinc-600">
            {!hasAIKey
              ? "Add an AI key in Settings to enable automated fixes."
              : "Connect a GitHub integration to enable automated fixes."}
          </p>
        </div>
      </section>
    );
  }

  // Idle state — show the start button
  if (state.status === "idle") {
    return (
      <section className="rounded-xl border border-cyan-900/30 bg-cyan-950/10 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-cyan-900/20">
          <Wrench className="h-4 w-4 text-cyan-400" />
          <span className="text-xs font-medium uppercase tracking-wider text-cyan-400">AI Remediation</span>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-zinc-400">
            Let AI diagnose the error, generate a fix, verify it with CI, and create a pull request.
          </p>
          {isVercelOnly && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5">
              <p className="text-[13px] text-amber-500/90 leading-relaxed">
                <strong>Heads-up:</strong> This alert came from Vercel only. Build logs will be fetched automatically if available. For runtime errors, connecting <a href="/settings/integrations" className="underline hover:text-amber-400 font-medium">Sentry</a> provides stack traces for more precise fixes.
              </p>
            </div>
          )}
          <button
            onClick={handleStart}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
            Fix with AI
          </button>
        </div>
      </section>
    );
  }

  // Active / completed states
  return (
    <section className={`rounded-xl border overflow-hidden ${
      state.status === "completed" ? "border-emerald-900/30 bg-emerald-950/10"
      : state.status === "failed" || state.status === "cancelled" ? "border-red-900/30 bg-red-950/10"
      : state.status === "proposing" ? "border-cyan-900/30 bg-cyan-950/10"
      : "border-blue-900/30 bg-blue-950/10"
    }`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-white/5">
        {isActive ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
        ) : state.status === "completed" ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        ) : state.status === "proposing" ? (
          <GitMerge className="h-4 w-4 text-cyan-400" />
        ) : (
          <XCircle className="h-4 w-4 text-red-400" />
        )}
        <span className={`text-xs font-medium uppercase tracking-wider ${
          isActive ? "text-blue-400"
          : state.status === "completed" ? "text-emerald-400"
          : state.status === "proposing" ? "text-cyan-400"
          : "text-red-400"
        }`}>
          AI Remediation
          {isActive && <span className="ml-1.5 normal-case font-normal text-zinc-500">
            — {formatStatus(state.status)}
          </span>}
        </span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {expanded && (
        <div className="px-5 py-4 space-y-4">
          {/* Confidence badge */}
          {state.confidence !== null && (
            <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              state.confidence >= 80  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              : state.confidence >= 50 ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
              : "bg-red-500/10 text-red-400 border border-red-500/20"
            }`}>
              {state.confidence >= 80 ? "🟢" : state.confidence >= 50 ? "🟡" : "🔴"}
              {state.confidence}% confidence
              {state.confidence < 50 && " — manual review required"}
              {state.confidence >= 50 && state.confidence < 80 && " — review carefully"}
            </div>
          )}

          {/* Steps timeline */}
          {state.steps.length > 0 && (
            <div className="space-y-2">
              {state.steps.map((step) => (
                <div key={step.id} className="flex items-start gap-2.5">
                  <div className="mt-0.5 shrink-0">{STEP_ICON[step.status]}</div>
                  <p className={`text-sm leading-relaxed ${
                    step.status === "failed" ? "text-red-400" : "text-fg-base"
                  }`}>
                    {step.message}
                  </p>
                </div>
              ))}
              <div ref={stepsEndRef} />
            </div>
          )}

          {/* Warning (blocked files) */}
          {state.warning && (
            <div className="rounded-lg border border-amber-900/30 bg-amber-950/20 px-3 py-2">
              <p className="text-xs text-amber-400">⚠️ {state.warning}</p>
            </div>
          )}

          {/* Diff preview */}
          {state.diffFiles.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 space-y-1">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Files to be changed</p>
              {state.diffFiles.map((f) => (
                <div key={f.path} className="flex items-center justify-between gap-2">
                  <code className="text-xs text-zinc-300 font-mono">{f.path}</code>
                  <span className="text-xs text-zinc-600 shrink-0">{f.lines} lines</span>
                </div>
              ))}
            </div>
          )}

          {/* Self-review result */}
          {state.selfReview && (
            <div className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${
              state.selfReview.recommendation === "approve" ? "border-emerald-900/30 bg-emerald-950/20"
              : state.selfReview.recommendation === "reject" ? "border-red-900/30 bg-red-950/20"
              : "border-amber-900/30 bg-amber-950/20"
            }`}>
              <div className="flex items-center gap-2">
                <Eye className="h-3.5 w-3.5 text-zinc-400" />
                <p className="text-xs font-medium text-zinc-300">
                  Self-review: {state.selfReview.score}/100 — {state.selfReview.recommendation}
                </p>
              </div>
              {state.selfReview.concerns.length > 0 && (
                <ul className="text-xs text-zinc-500 space-y-0.5 ml-5">
                  {state.selfReview.concerns.map((c, i) => (
                    <li key={i}>• {c}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Gate results */}
          {state.gates && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 space-y-1.5">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="h-3.5 w-3.5 text-zinc-400" />
                <p className="text-xs font-medium text-zinc-300 uppercase tracking-wider">
                  Safety gates — {state.mergeStrategy === "auto_merge" ? "Auto-merge" : "Draft PR"}
                </p>
              </div>
              {state.gates.map((gate) => (
                <div key={gate.name} className="flex items-center gap-2 text-xs">
                  {gate.passed
                    ? <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
                    : <XCircle className="h-3 w-3 text-red-400 shrink-0" />}
                  <span className={gate.passed ? "text-zinc-400" : "text-red-400"}>
                    {gate.reason}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Post-merge monitoring */}
          {state.monitoring && !state.autoReverted && (
            <div className="rounded-lg border border-blue-900/30 bg-blue-950/20 px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 className={`h-3.5 w-3.5 text-blue-400 ${state.monitoring.status === "watching" ? "animate-spin" : ""}`} />
                <p className="text-xs font-medium text-blue-300">
                  Post-merge monitoring — {Math.round(state.monitoring.elapsed)}s / {state.monitoring.total}s
                </p>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-1.5">
                <div
                  className="bg-blue-500 h-1.5 rounded-full transition-all duration-1000"
                  style={{ width: `${Math.min(100, (state.monitoring.elapsed / state.monitoring.total) * 100)}%` }}
                />
              </div>
              {state.monitoring.checks && (
                <div className="flex gap-4 text-xs">
                  {state.monitoring.checks.sentry && (
                    <span className={state.monitoring.checks.sentry === "ok" ? "text-emerald-400" : "text-red-400"}>
                      Sentry: {state.monitoring.checks.sentry}
                    </span>
                  )}
                  {state.monitoring.checks.uptime && (
                    <span className={state.monitoring.checks.uptime === "ok" ? "text-emerald-400" : "text-red-400"}>
                      Uptime: {state.monitoring.checks.uptime}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Auto-revert notification */}
          {state.autoReverted && (
            <div className="rounded-lg border border-red-900/30 bg-red-950/20 px-4 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <Undo2 className="h-4 w-4 text-red-400" />
                <p className="text-sm text-red-300 font-medium">Auto-reverted</p>
              </div>
              <p className="text-xs text-red-400/80">
                Reason: {state.autoReverted.reason}
              </p>
              {state.autoReverted.revertPrUrl && (
                <a
                  href={state.autoReverted.revertPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 underline underline-offset-2"
                >
                  View revert PR
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {/* Error message */}
          {state.error && state.status === "failed" && !state.autoReverted && (
            <div className="rounded-lg border border-red-900/30 bg-red-950/20 px-4 py-3">
              <p className="text-sm text-red-400">{state.error}</p>
            </div>
          )}

          {/* Proposing state — draft PR ready for review */}
          {state.status === "proposing" && state.prUrl && (
            <div className="space-y-3">
              <div className="rounded-lg border border-cyan-900/30 bg-cyan-950/20 px-4 py-3 space-y-2">
                <p className="text-sm text-cyan-300 font-medium">CI passes — Draft PR created</p>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  This is a <strong className="text-zinc-300">draft PR</strong> — review all changes on GitHub before marking it ready to merge. It cannot be merged until you approve it.
                </p>
                <a
                  href={state.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                >
                  Review Draft PR #{state.prNumber} on GitHub
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
                <p className="text-xs text-zinc-500 leading-relaxed">
                  On GitHub: review the diff → mark as ready → merge. We recommend enabling branch protection rules to require CI to pass before merging.
                </p>
              </div>
              <button
                onClick={handleCancel}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-fg-base hover:border-zinc-600 transition-colors"
              >
                <X className="h-4 w-4" />
                Dismiss
              </button>
            </div>
          )}

          {/* Completed state */}
          {state.status === "completed" && !state.autoReverted && (
            <div className="rounded-lg border border-emerald-900/30 bg-emerald-950/20 px-4 py-3 space-y-1">
              <p className="text-sm text-emerald-400 font-medium">
                {state.autoMerged
                  ? "Fix auto-merged and monitoring passed. The alert has been resolved."
                  : "Fix merged successfully. The alert has been auto-resolved."}
              </p>
              {state.prUrl && (
                <a
                  href={state.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-emerald-500/70 hover:text-emerald-400 underline underline-offset-2"
                >
                  View merged PR
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          )}

          {/* Failed / cancelled — retry button */}
          {(state.status === "failed" || state.status === "cancelled") && (
            <button
              onClick={handleRetry}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-fg-base hover:border-zinc-600 transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              Try again
            </button>
          )}

          {/* Cancel button for active sessions */}
          {isActive && (
            <button
              onClick={handleCancel}
              className="inline-flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <X className="h-3 w-3" />
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
    analyzing: "analyzing error",
    reading_code: "reading source code",
    generating_fix: "generating fix",
    pushing: "pushing to GitHub",
    awaiting_ci: "waiting for CI",
    proposing: "ready for review",
    merging: "auto-merging",
    monitoring: "post-merge monitoring",
  };
  return map[status] ?? status;
}
