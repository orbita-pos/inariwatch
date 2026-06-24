"use client";

/**
 * Backend panel — Substrate I/O events captured server-side, rendered as
 * a scrollable list synced to the playhead. Companion to NetworkPanel:
 *   - NetworkPanel  → frontend HTTP requests (rrweb fetch interceptor)
 *   - BackendPanel  → server-side I/O (Substrate ring buffer)
 *
 * The two are linked by FullTrace's session_id propagation: a click in
 * the frontend that triggers a POST → backend SQL is the SAME causal
 * chain across panels. Future iteration will draw cross-track arrows;
 * for now the shared scrubber + click-to-seek already lets a reviewer
 * switch tabs and follow the timeline.
 *
 * Visual contract:
 *   - Sticky filter chip row (All + per-category counts)
 *   - One row per event with category badge + summary + duration/status
 *   - Currently-active row gets the same accent bar as ConsolePanel
 *   - Empty states stay quiet — many sessions have zero Substrate data
 */

import { useMemo, useRef, useEffect, useState } from "react";
import { formatMs } from "../format-time";
import type { BackendEvent, BackendCategory } from "@/lib/fulltrace/manifest-aggregator";

interface BackendPanelProps {
  events: BackendEvent[];
  currentMs: number;
  onSeek: (ms: number) => void;
  /** VAR Q1 — fired with the row's event id on mouseenter, null on
   *  mouseleave. Lets the timeline canvas overlay causal arrows. */
  onHoverEvent?: (id: string | null) => void;
}

export function countBackendRows(events: BackendEvent[]): {
  total: number;
  errors: number;
  byCategory: Record<BackendCategory, number>;
} {
  const byCategory = {
    http: 0, db: 0, fs: 0, dns: 0,
    exception: 0, process: 0, time: 0, random: 0, marker: 0,
  } as Record<BackendCategory, number>;
  let errors = 0;
  for (const e of events) {
    byCategory[e.category]++;
    if (isErrored(e)) errors++;
  }
  return { total: events.length, errors, byCategory };
}

function isErrored(e: BackendEvent): boolean {
  if (e.errorMessage) return true;
  if (e.category === "exception") return true;
  if (typeof e.status === "number" && e.status >= 400) return true;
  return false;
}

const CATEGORY_TONES: Record<BackendCategory, { badge: string; dot: string }> = {
  http:      { badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",       dot: "bg-blue-400" },
  db:        { badge: "bg-purple-500/15 text-purple-600 dark:text-purple-400", dot: "bg-purple-400" },
  fs:        { badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-400" },
  dns:       { badge: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",       dot: "bg-cyan-400" },
  exception: { badge: "bg-red-500/15 text-red-600 dark:text-red-400",          dot: "bg-red-400" },
  process:   { badge: "bg-slate-500/15 text-slate-500",                         dot: "bg-slate-400" },
  time:      { badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",     dot: "bg-amber-400" },
  random:    { badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",     dot: "bg-amber-400" },
  marker:    { badge: "bg-slate-500/10 text-slate-500",                          dot: "bg-slate-300" },
};

/**
 * Find the row whose timestamp is closest to (and ≤) currentMs. Returns -1
 * when the playhead is before the first event. Same semantics as the
 * NetworkPanel + ConsolePanel "active row" indicator.
 */
function findActiveBackendIndex(events: BackendEvent[], currentMs: number): number {
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

type CategoryFilter = "all" | BackendCategory;

export function BackendPanel({ events, currentMs, onSeek, onHoverEvent }: BackendPanelProps) {
  const [filter, setFilter] = useState<CategoryFilter>("all");

  const counts = useMemo(() => countBackendRows(events), [events]);

  const filtered = useMemo(
    () => (filter === "all" ? events : events.filter((e) => e.category === filter)),
    [events, filter],
  );

  // Categories that actually appear in the dataset, sorted by count desc.
  // We only render filter chips for these — no need to show "fs (0)" if
  // the session has no filesystem activity.
  const visibleCategories = useMemo<BackendCategory[]>(() => {
    const present: BackendCategory[] = [];
    for (const cat of ["http", "db", "fs", "dns", "exception", "process", "time", "random", "marker"] as BackendCategory[]) {
      if (counts.byCategory[cat] > 0) present.push(cat);
    }
    return present;
  }, [counts]);

  const activeIndex = useMemo(() => findActiveBackendIndex(filtered, currentMs), [filtered, currentMs]);

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const node = listRef.current.querySelector<HTMLLIElement>(`[data-idx="${activeIndex}"]`);
    if (node) node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  return (
    <div className="flex h-full flex-col">
      {/* Sticky filter row */}
      <div className="sticky top-0 z-10 flex items-center gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-1.5 text-[10px]">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={`All ${counts.total}`} />
        {visibleCategories.map((cat) => (
          <FilterChip
            key={cat}
            active={filter === cat}
            onClick={() => setFilter(cat)}
            label={`${cat} ${counts.byCategory[cat]}`}
            dot={CATEGORY_TONES[cat].dot}
          />
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-fg-base/50">
          {events.length === 0
            ? "No backend I/O captured. Enable @inariwatch/substrate-agent to record server-side calls."
            : "No events match the active filter."}
        </div>
      ) : (
        <ul ref={listRef} className="divide-y divide-line text-[11px] font-mono">
          {filtered.map((row, i) => {
            const isActive = i === activeIndex;
            const tone = CATEGORY_TONES[row.category];
            const errored = isErrored(row);
            return (
              <li
                key={row.id}
                data-idx={i}
                className={`relative px-3 py-1.5 transition-colors cursor-pointer ${
                  isActive ? "bg-inari-accent/5" : "hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                }`}
                onClick={() => onSeek(row.ts)}
                onMouseEnter={() => onHoverEvent?.(row.id)}
                onMouseLeave={() => onHoverEvent?.(null)}
                title={`${row.type} — ${formatMs(row.ts)} — click to seek, hover to highlight related events`}
              >
                {isActive && (
                  <span className="absolute left-0 top-0 h-full w-0.5 bg-inari-accent" aria-hidden="true" />
                )}
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 rounded px-1 font-semibold uppercase ${tone.badge}`}>
                    {row.category}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg-base" title={row.summary}>
                    {row.summary || row.type}
                  </span>
                  {typeof row.status === "number" && (
                    <span
                      className={`shrink-0 rounded px-1 tabular-nums ${
                        row.status >= 500 ? "bg-red-500/15 text-red-500"
                        : row.status >= 400 ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                        : "text-fg-base/40"
                      }`}
                    >
                      {row.status}
                    </span>
                  )}
                  <span className="shrink-0 tabular-nums text-fg-base/40">
                    {typeof row.durationMs === "number" ? `${Math.round(row.durationMs)}ms` : formatMs(row.ts)}
                  </span>
                </div>
                {errored && row.errorMessage && (
                  <div className="mt-1 ml-12 text-[10px] text-red-500/80 truncate" title={row.errorMessage}>
                    {row.errorMessage}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  dot?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium uppercase tracking-wider transition-colors ${
        active ? "bg-inari-accent/15 text-inari-accent" : "text-fg-base/60 hover:text-fg-base"
      }`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}
