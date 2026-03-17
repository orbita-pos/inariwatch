"use client";

import { useState, useEffect, useRef, useTransition } from "react";
import {
  Wrench, Loader2, CheckCircle2, XCircle, Clock,
  ExternalLink, GitMerge, X, RotateCcw, ChevronDown, ChevronUp,
} from "lucide-react";
import { startRemediation, approveRemediation, cancelRemediation } from "./remediation-actions";

type Step = {
  id: string;
  type: string;
  message: string;
  status: "running" | "completed" | "failed";
  timestamp: string;
};

type SessionState = {
  sessionId: string | null;
  status: string;
  steps: Step[];
  prUrl: string | null;
  prNumber: number | null;
  error: string | null;
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
  existingSession,
}: {
  alertId: string;
  hasAIKey: boolean;
  hasGitHub: boolean;
  existingSession?: { id: string; status: string; steps: unknown; prUrl: string | null; prNumber: number | null; error: string | null } | null;
}) {
  const [state, setState] = useState<SessionState>({
    sessionId: existingSession?.id ?? null,
    status: existingSession?.status ?? "idle",
    steps: (existingSession?.steps as Step[]) ?? [],
    prUrl: existingSession?.prUrl ?? null,
    prNumber: existingSession?.prNumber ?? null,
    error: existingSession?.error ?? null,
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

    es.addEventListener("done", (e) => {
      const data = JSON.parse(e.data);
      setState((s) => ({
        ...s,
        status: data.status,
        prUrl: data.prUrl ?? s.prUrl,
        prNumber: data.prNumber ?? s.prNumber,
        error: data.error ?? s.error,
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
    setState({ sessionId: null, status: "idle", steps: [], prUrl: null, prNumber: null, error: null });
    handleStart();
  }

  const isActive = !["idle", "completed", "failed", "cancelled", "proposing"].includes(state.status);

  // Don't show panel if no AI key or no GitHub integration
  if (!hasAIKey || !hasGitHub) {
    return (
      <section className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[#1a1a1a]">
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
          {/* Steps timeline */}
          {state.steps.length > 0 && (
            <div className="space-y-2">
              {state.steps.map((step) => (
                <div key={step.id} className="flex items-start gap-2.5">
                  <div className="mt-0.5 shrink-0">{STEP_ICON[step.status]}</div>
                  <p className={`text-sm leading-relaxed ${
                    step.status === "failed" ? "text-red-400" : "text-zinc-300"
                  }`}>
                    {step.message}
                  </p>
                </div>
              ))}
              <div ref={stepsEndRef} />
            </div>
          )}

          {/* Error message */}
          {state.error && state.status === "failed" && (
            <div className="rounded-lg border border-red-900/30 bg-red-950/20 px-4 py-3">
              <p className="text-sm text-red-400">{state.error}</p>
            </div>
          )}

          {/* Proposing state — show PR and action buttons */}
          {state.status === "proposing" && state.prUrl && (
            <div className="space-y-3">
              <div className="rounded-lg border border-cyan-900/30 bg-cyan-950/20 px-4 py-3">
                <p className="text-sm text-cyan-300 font-medium mb-1">Fix verified — CI passes</p>
                <a
                  href={state.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                >
                  View PR #{state.prNumber} on GitHub
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleApprove}
                  disabled={merging}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                >
                  {merging ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
                  Approve & Merge
                </button>
                <button
                  onClick={handleCancel}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
                >
                  <X className="h-4 w-4" />
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Completed state */}
          {state.status === "completed" && (
            <div className="rounded-lg border border-emerald-900/30 bg-emerald-950/20 px-4 py-3">
              <p className="text-sm text-emerald-400 font-medium">
                Fix merged successfully. The alert has been auto-resolved.
              </p>
              {state.prUrl && (
                <a
                  href={state.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-1 text-sm text-emerald-500/70 hover:text-emerald-400 underline underline-offset-2"
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
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
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
    proposing: "ready for approval",
    merging: "merging PR",
  };
  return map[status] ?? status;
}
