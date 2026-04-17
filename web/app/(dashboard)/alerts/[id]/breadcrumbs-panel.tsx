"use client";

/**
 * Breadcrumbs panel on the alert detail page.
 *
 * Renders the chronological trail of console + fetch events the
 * Capture SDK captured in the ~30 seconds before the error fired.
 * Each row:
 *   [time before crash]  [category/level badge]  [message]
 *
 * Collapsed by default — just a "N breadcrumbs" strip — expand to see
 * the full timeline. Color-coded by level (info/warning/error).
 *
 * Renders nothing when the alert has no breadcrumbs or the payload
 * is malformed.
 */

import { useState } from "react";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";

interface BreadcrumbPayload {
  timestamp?: unknown;
  category?: unknown;
  level?: unknown;
  message?: unknown;
}

export interface BreadcrumbsPanelProps {
  data: unknown;
}

export function BreadcrumbsPanel({ data }: BreadcrumbsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const crumbs = narrow(data);

  if (crumbs.length === 0) return null;

  const last = crumbs[crumbs.length - 1];
  const lastMs = parseTsMs(last.timestamp);

  // Count by level for the header strip so the reviewer can tell at
  // a glance whether the pre-crash period was noisy.
  const counts = crumbs.reduce<Record<string, number>>((acc, c) => {
    acc[c.level] = (acc[c.level] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-left hover:bg-surface-inner/50"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-base/60" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-base/60" aria-hidden />
          )}
          <Activity className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            Breadcrumbs
          </h3>
          <span className="text-[10px] text-fg-base/50">
            {crumbs.length} events before the crash
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {counts.error ? <span className="rounded bg-red-500/15 px-1 text-red-600 dark:text-red-400">{counts.error} error</span> : null}
          {counts.warning ? <span className="rounded bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400">{counts.warning} warn</span> : null}
          {counts.info ? <span className="rounded bg-fg-base/10 px-1 text-fg-base/70">{counts.info} info</span> : null}
        </div>
      </button>

      {expanded && (
        <ul className="max-h-80 overflow-y-auto divide-y divide-line/60 text-[11px]">
          {crumbs.map((c, i) => {
            const tsMs = parseTsMs(c.timestamp);
            const deltaMs = lastMs != null && tsMs != null ? lastMs - tsMs : null;
            return (
              <li key={i} className={`flex items-start gap-2 px-4 py-1.5 ${levelBg(c.level)}`}>
                <span className="shrink-0 w-14 tabular-nums text-fg-base/50">
                  {deltaMs !== null ? `-${formatMs(deltaMs)}` : ""}
                </span>
                <span className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase ${levelBadge(c.level)}`}>
                  {c.category}
                </span>
                <span className="min-w-0 flex-1 text-fg-base/80 break-words">
                  {c.message}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Narrowing + formatting ────────────────────────────────────────────────

interface NarrowedCrumb {
  timestamp: string;
  category: string;
  level: "info" | "warning" | "error";
  message: string;
}

function narrow(data: unknown): NarrowedCrumb[] {
  if (!Array.isArray(data)) return [];
  const out: NarrowedCrumb[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as BreadcrumbPayload;
    const timestamp = typeof b.timestamp === "string" ? b.timestamp : "";
    const category = typeof b.category === "string" ? b.category : "custom";
    const level = typeof b.level === "string" && ["info", "warning", "error"].includes(b.level)
      ? (b.level as NarrowedCrumb["level"])
      : "info";
    const message = typeof b.message === "string" ? b.message : "";
    if (!message && !timestamp) continue;
    out.push({ timestamp, category, level, message });
  }
  return out.slice(-30); // match SDK ring-buffer size
}

function parseTsMs(ts: string | unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function levelBadge(level: NarrowedCrumb["level"]): string {
  return {
    info: "bg-fg-base/15 text-fg-base/70",
    warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    error: "bg-red-500/15 text-red-600 dark:text-red-400",
  }[level];
}

function levelBg(level: NarrowedCrumb["level"]): string {
  return {
    info: "",
    warning: "bg-amber-500/[0.03]",
    error: "bg-red-500/[0.03]",
  }[level];
}
