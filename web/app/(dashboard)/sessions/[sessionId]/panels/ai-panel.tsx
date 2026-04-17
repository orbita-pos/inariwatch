"use client";

/**
 * AI panel — alerts, diagnoses, and remediation steps that fired during
 * this session, in chronological order. Closes the FullTrace loop:
 *   - User clicked something (DOM track)
 *   - Backend made a request that failed (Backend track)
 *   - Alert fired with AI diagnosis (AI track ← this panel)
 *   - Remediation generated a fix and merged (also AI track)
 *
 * Visual contract:
 *   - Each event is a row with an icon + tone-colored left border
 *   - Diagnosis bodies are collapsible (often long; default collapsed)
 *   - Click row → seek to that moment in the timeline
 *   - PR / revert URLs render as small chips, not full links (avoids
 *     accidental navigation when the user wants to seek)
 *
 * The panel is intentionally narrative-first: someone reading the session
 * post-incident should be able to follow the story top-to-bottom without
 * touching the player. Click-to-seek is the secondary affordance.
 */

import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Brain, Wrench, GitMerge, RotateCcw, CheckCircle2, XCircle, ChevronRight, ExternalLink, FlaskConical, Loader2 } from "lucide-react";
import { formatMs } from "../format-time";
import type { AiEvent, AiEventKind } from "@/lib/fulltrace/manifest-aggregator";

interface AiPanelProps {
  events: AiEvent[];
  currentMs: number;
  onSeek: (ms: number) => void;
  /** VAR Q1 — fired with the row's event id on mouseenter, null on
   *  mouseleave. Drives the timeline canvas's causal-arrows overlay. */
  onHoverEvent?: (id: string | null) => void;
  /** VAR Q1 Sesión 5 — required for the What-If button on remediation
   *  events. When omitted the button is hidden. */
  sessionId?: string;
}

/** Local state per row for the What-If button. Keyed by AiEvent.id. */
type WhatIfState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; outcome: string; confidence: number; riskScore: number; analysis: string; fromCache: boolean }
  | { status: "error"; message: string };

export function countAiRows(events: AiEvent[]): {
  total: number;
  alerts: number;
  failures: number;
} {
  let alerts = 0;
  let failures = 0;
  for (const e of events) {
    if (e.kind === "alert") alerts++;
    if (e.kind === "remediation_failed" || e.kind === "fix_reverted") failures++;
  }
  return { total: events.length, alerts, failures };
}

const KIND_META: Record<AiEventKind, {
  icon: LucideIcon;
  defaultTone: AiEvent["tone"];
}> = {
  alert:                  { icon: AlertTriangle, defaultTone: "warning" },
  diagnosis:              { icon: Brain,          defaultTone: "info" },
  remediation_started:    { icon: Wrench,         defaultTone: "info" },
  remediation_step:       { icon: ChevronRight,   defaultTone: "info" },
  remediation_completed:  { icon: CheckCircle2,   defaultTone: "success" },
  remediation_failed:     { icon: XCircle,        defaultTone: "danger" },
  fix_merged:             { icon: GitMerge,       defaultTone: "success" },
  fix_reverted:           { icon: RotateCcw,      defaultTone: "danger" },
};

const TONE_CLASSES: Record<NonNullable<AiEvent["tone"]>, { border: string; icon: string; badge: string }> = {
  critical: { border: "border-l-red-500",      icon: "text-red-500",      badge: "bg-red-500/15 text-red-600 dark:text-red-400" },
  danger:   { border: "border-l-red-500",      icon: "text-red-500",      badge: "bg-red-500/15 text-red-600 dark:text-red-400" },
  warning:  { border: "border-l-amber-500",    icon: "text-amber-500",    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  success:  { border: "border-l-emerald-500",  icon: "text-emerald-500",  badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  info:     { border: "border-l-inari-accent", icon: "text-inari-accent", badge: "bg-inari-accent/15 text-inari-accent" },
};

function findActiveAiIndex(events: AiEvent[], currentMs: number): number {
  if (events.length === 0) return -1;
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].ts <= currentMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Try to detect "external URL" in a body field so we render it as a link
 *  chip instead of a plain truncated string. Used for remediation PR URLs
 *  and revert PR URLs that the aggregator passes through `body`. */
function isHttpUrl(maybe: string | undefined): maybe is string {
  if (!maybe) return false;
  return maybe.startsWith("http://") || maybe.startsWith("https://");
}

/** Event kinds where running What-If is meaningful — both have a remediationId
 *  AND there's a fix to evaluate against the recorded session. We deliberately
 *  exclude `remediation_started` (no fix yet) and `remediation_failed` (nothing
 *  to test). */
const WHATIF_ELIGIBLE_KINDS: AiEventKind[] = ["remediation_completed", "fix_merged"];

export function AiPanel({ events, currentMs, onSeek, onHoverEvent, sessionId }: AiPanelProps) {
  // What-If state per row. Map keyed by event id keeps independent UI state
  // for each remediation event, since a session can have multiple completed
  // remediations (different attempts, different alerts).
  const [whatIfStates, setWhatIfStates] = useState<Map<string, WhatIfState>>(new Map());

  const runWhatIf = useCallback(async (evt: AiEvent) => {
    if (!sessionId || !evt.remediationId) return;
    setWhatIfStates((prev) => new Map(prev).set(evt.id, { status: "loading" }));
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/what-if`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remediationId: evt.remediationId }),
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        setWhatIfStates((prev) =>
          new Map(prev).set(evt.id, { status: "error", message: errBody.error ?? `HTTP ${r.status}` }),
        );
        return;
      }
      const data = await r.json();
      setWhatIfStates((prev) =>
        new Map(prev).set(evt.id, {
          status: "ready",
          outcome: data.outcome,
          confidence: data.confidence,
          riskScore: data.riskScore,
          analysis: data.analysis,
          fromCache: data.fromCache,
        }),
      );
    } catch (e) {
      setWhatIfStates((prev) =>
        new Map(prev).set(evt.id, { status: "error", message: e instanceof Error ? e.message : "Network error" }),
      );
    }
  }, [sessionId]);

  const counts = useMemo(() => countAiRows(events), [events]);
  const activeIndex = useMemo(() => findActiveAiIndex(events, currentMs), [events, currentMs]);

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const node = listRef.current.querySelector<HTMLLIElement>(`[data-idx="${activeIndex}"]`);
    if (node) node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  // Diagnosis rows can have long bodies — we render the first 200 chars by
  // default and let the user expand. Per-row expansion state keeps the UX
  // consistent with NetworkPanel's body viewer.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-fg-base/50">
        No alerts or remediations linked to this session yet.
        <br />
        AI events show up here when an error from this session triggers an alert.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header summary — shows counts at a glance */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[10px] uppercase tracking-wider text-fg-base/60">
        <span>{counts.total} events</span>
        {counts.alerts > 0 && (
          <span className="rounded-sm bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400">
            {counts.alerts} alert{counts.alerts === 1 ? "" : "s"}
          </span>
        )}
        {counts.failures > 0 && (
          <span className="rounded-sm bg-red-500/15 px-1 text-red-600 dark:text-red-400">
            {counts.failures} fail{counts.failures === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <ul ref={listRef} className="flex-1 divide-y divide-line text-[11px]">
        {events.map((evt, i) => {
          const isActive = i === activeIndex;
          const tone = TONE_CLASSES[evt.tone ?? KIND_META[evt.kind].defaultTone ?? "info"];
          const Icon = KIND_META[evt.kind].icon;
          const hasBody = !!evt.body && evt.body.length > 0;
          const isExpanded = expanded.has(evt.id);
          const bodyIsUrl = isHttpUrl(evt.body);

          return (
            <li
              key={evt.id}
              data-idx={i}
              className={`relative border-l-2 ${tone.border} px-3 py-2 transition-colors cursor-pointer ${
                isActive ? "bg-inari-accent/5" : "hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
              }`}
              onClick={() => onSeek(evt.ts)}
              onMouseEnter={() => onHoverEvent?.(evt.id)}
              onMouseLeave={() => onHoverEvent?.(null)}
              title={`${formatMs(evt.ts)} — click to seek, hover to highlight related events`}
            >
              <div className="flex items-start gap-2">
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone.icon}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-fg-strong truncate">{evt.title}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-[10px] text-fg-base/40">
                      {formatMs(evt.ts)}
                    </span>
                  </div>
                  {hasBody && (
                    bodyIsUrl ? (
                      <a
                        href={evt.body}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono ${tone.badge} hover:underline`}
                      >
                        <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                        {prettifyUrl(evt.body!)}
                      </a>
                    ) : (
                      <>
                        <p
                          className={`mt-1 text-fg-base/70 ${isExpanded ? "" : "line-clamp-3"}`}
                          onClick={(e) => {
                            if (evt.body!.length > 200) {
                              e.stopPropagation();
                              toggle(evt.id);
                            }
                          }}
                        >
                          {evt.body}
                        </p>
                        {evt.body!.length > 200 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(evt.id);
                            }}
                            className="mt-0.5 text-[10px] text-fg-base/50 hover:text-fg-base"
                          >
                            {isExpanded ? "Show less" : "Show more"}
                          </button>
                        )}
                      </>
                    )
                  )}
                  {/* VAR Q1 Sesión 5A — What-If button + inline result.
                      Renders only for completed/merged remediation events
                      with a remediationId AND when sessionId is wired in. */}
                  {sessionId && evt.remediationId && WHATIF_ELIGIBLE_KINDS.includes(evt.kind) && (
                    <WhatIfWidget
                      state={whatIfStates.get(evt.id) ?? { status: "idle" }}
                      onRun={() => runWhatIf(evt)}
                    />
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Trim a long URL to host + last path segment for compact chip display. */
function prettifyUrl(url: string): string {
  try {
    const u = new URL(url);
    const lastSeg = u.pathname.split("/").filter(Boolean).pop();
    return lastSeg ? `${u.host}/…/${lastSeg}` : u.host;
  } catch {
    return url.slice(0, 40);
  }
}

// ── What-If widget ────────────────────────────────────────────────────────
//
// Inline button + result render for the AI panel. Stateless — the parent
// AiPanel owns the per-row state map and passes the current value plus a
// run callback. Three visual states: idle (button), loading (spinner),
// ready (outcome chip + analysis), error (small red message).

const OUTCOME_TONE: Record<string, { bg: string; text: string; label: string }> = {
  would_prevent:     { bg: "bg-emerald-500/15", text: "text-emerald-600 dark:text-emerald-400", label: "Would prevent" },
  uncertain:         { bg: "bg-amber-500/15",   text: "text-amber-600 dark:text-amber-400",     label: "Uncertain" },
  would_not_prevent: { bg: "bg-red-500/15",     text: "text-red-600 dark:text-red-400",         label: "Would NOT prevent" },
};

function WhatIfWidget({ state, onRun }: { state: WhatIfState; onRun: () => void }) {
  if (state.status === "idle") {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRun();
        }}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-inner px-2 py-1 text-[10px] font-medium text-fg-base/80 transition-colors hover:border-inari-accent/40 hover:text-fg-strong"
        title="Predict whether this fix would have prevented the recorded incident"
      >
        <FlaskConical className="h-3 w-3 text-inari-accent" aria-hidden="true" />
        Run What-If
      </button>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-inner px-2 py-1 text-[10px] text-fg-base/60">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Predicting outcome…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-2 text-[10px] text-red-500/80" title={state.message}>
        ⚠ What-If failed: {state.message}
      </div>
    );
  }

  // ready
  const tone = OUTCOME_TONE[state.outcome] ?? OUTCOME_TONE.uncertain;
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-inner p-2">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone.bg} ${tone.text}`}>
          {tone.label}
        </span>
        <span className="text-[10px] tabular-nums text-fg-base/60">
          confidence {state.confidence}%
        </span>
        <span className="text-[10px] tabular-nums text-fg-base/60">
          risk {state.riskScore}/100
        </span>
        {state.fromCache && (
          <span className="ml-auto text-[9px] uppercase tracking-wider text-fg-base/40">cached</span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-fg-base/80">{state.analysis}</p>
    </div>
  );
}
