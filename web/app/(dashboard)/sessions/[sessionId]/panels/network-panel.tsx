"use client";

/**
 * Replay-synced network waterfall panel BODY. Mirrors the Chrome DevTools
 * Network tab layout but scoped to the captured session:
 *   - Sticky filter row (All / Failed)
 *   - Columns: Method · URL (truncated) · Status · Duration bar
 *   - Status tones: 2xx emerald · 3xx sky · 4xx amber · 5xx red · no-status slate
 *   - Duration bar width is relative to the max duration in the filtered set,
 *     so the visual comparison stays useful regardless of absolute scale
 *   - Click row → seek playback to that request's start
 *   - Current playback row gets an accent bar (same pattern as ConsolePanel)
 */

import { useMemo, useRef, useEffect, useState } from "react";
import { ChevronRight, Copy } from "lucide-react";
import type { DetailedEvent } from "../derive-detailed-events";
import { findActiveIndex } from "../derive-detailed-events";
import { formatMs } from "../format-time";

type NetworkRow = Extract<DetailedEvent, { kind: "network" }>;
type NetworkFilter = "all" | "failed";

interface NetworkPanelProps {
  events: DetailedEvent[];
  currentMs: number;
  onSeek: (ms: number) => void;
}

export function countNetworkRows(events: DetailedEvent[]): {
  total: number;
  failed: number;
} {
  let total = 0;
  let failed = 0;
  for (const e of events) {
    if (e.kind !== "network") continue;
    total++;
    if (isFailed(e)) failed++;
  }
  return { total, failed };
}

function isFailed(e: NetworkRow): boolean {
  if (e.errorMessage) return true;
  if (typeof e.status === "number" && e.status >= 400) return true;
  return false;
}

/** 200→emerald · 300→sky · 400→amber · 5xx→red · null→slate. */
function statusTone(status: number | undefined, errorMessage: string | undefined): {
  badge: string;
  barFrom: string;
  barTo: string;
} {
  if (errorMessage) {
    return { badge: "bg-red-500/15 text-red-600 dark:text-red-400", barFrom: "from-red-500/60", barTo: "to-red-500/30" };
  }
  if (typeof status !== "number") {
    return { badge: "bg-slate-500/10 text-slate-500", barFrom: "from-slate-400/50", barTo: "to-slate-400/20" };
  }
  if (status >= 500) {
    return { badge: "bg-red-500/15 text-red-600 dark:text-red-400", barFrom: "from-red-500/60", barTo: "to-red-500/30" };
  }
  if (status >= 400) {
    return { badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400", barFrom: "from-amber-500/60", barTo: "to-amber-500/30" };
  }
  if (status >= 300) {
    return { badge: "bg-sky-500/15 text-sky-600 dark:text-sky-400", barFrom: "from-sky-500/60", barTo: "to-sky-500/30" };
  }
  return { badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", barFrom: "from-emerald-500/60", barTo: "to-emerald-500/30" };
}

/**
 * Truncate a URL to the last 2 path segments + indicate query presence.
 * e.g. `https://api.example.com/v1/users/42?id=1&token=abc` →
 *      `…/users/42?+2`   (2 query params hidden).
 */
function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").filter(Boolean);
    const shortPath = path.length <= 2 ? u.pathname : `…/${path.slice(-2).join("/")}`;
    const qs = u.search;
    if (!qs) return shortPath;
    const qCount = [...u.searchParams].length;
    return `${shortPath}?+${qCount}`;
  } catch {
    // Relative URL or malformed — fall back to last segment
    const parts = url.split("/").filter(Boolean);
    return parts.length <= 2 ? url : `…/${parts.slice(-2).join("/")}`;
  }
}

export function NetworkPanel({ events, currentMs, onSeek }: NetworkPanelProps) {
  const [filter, setFilter] = useState<NetworkFilter>("all");

  const rows = useMemo(
    () => events.filter((e): e is NetworkRow => e.kind === "network"),
    [events],
  );
  const filtered = useMemo(
    () => (filter === "failed" ? rows.filter(isFailed) : rows),
    [rows, filter],
  );
  const activeIndex = useMemo(() => findActiveIndex(filtered, currentMs), [filtered, currentMs]);

  // Max duration across filtered set — drives the duration-bar width.
  // Clamp to at least 1ms to avoid NaN when every request is instantaneous.
  const maxDuration = useMemo(() => {
    let max = 1;
    for (const r of filtered) {
      if (typeof r.durationMs === "number" && r.durationMs > max) max = r.durationMs;
    }
    return max;
  }, [filtered]);

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const node = listRef.current.querySelector<HTMLLIElement>(`[data-idx="${activeIndex}"]`);
    if (node) node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  const counts = useMemo(() => countNetworkRows(events), [events]);

  // Track which rows have their body viewer expanded. Keyed by event
  // timestamp+url since DetailedEvent doesn't carry a stable id and we
  // don't want one row collapse to scroll-jump everything else.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Sticky filter row */}
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-line bg-surface px-3 py-1.5 text-[10px]">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={`All ${counts.total}`} />
        <FilterChip
          active={filter === "failed"}
          onClick={() => setFilter("failed")}
          label={`Failed ${counts.failed}`}
          tone="error"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-fg-base/50">
          {rows.length === 0 ? "No network requests captured." : "No requests match the active filter."}
        </div>
      ) : (
        <ul ref={listRef} className="divide-y divide-line text-[11px] font-mono">
          {filtered.map((row, i) => {
            const isActive = i === activeIndex;
            const tones = statusTone(row.status, row.errorMessage);
            const durationPct = row.durationMs ? Math.max(2, (row.durationMs / maxDuration) * 100) : 0;
            const rowKey = `${row.timestamp}-${i}-${row.url}`;
            const isExpanded = expanded.has(rowKey);
            const hasBodies = !!(row.requestBody || row.responseBody || row.requestHeaders || row.responseHeaders);
            return (
              <li
                key={rowKey}
                data-idx={i}
                className={`relative px-3 py-1.5 transition-colors ${
                  isActive ? "bg-inari-accent/5" : "hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                }`}
              >
                {isActive && (
                  <span className="absolute left-0 top-0 h-full w-0.5 bg-inari-accent" aria-hidden="true" />
                )}
                <div
                  className="flex items-center gap-2 cursor-pointer"
                  onClick={() => onSeek(row.timestamp)}
                  title={`${row.method} ${row.url}\n${formatMs(row.timestamp)} — click to seek`}
                >
                  {hasBodies ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(rowKey);
                      }}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? "Hide body" : "Show body"}
                      className="shrink-0 rounded p-0.5 text-fg-base/40 hover:text-fg-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/40"
                    >
                      <ChevronRight
                        className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                  ) : (
                    <span className="shrink-0 w-3" aria-hidden="true" />
                  )}
                  <span className="shrink-0 w-10 font-semibold uppercase text-fg-base/70">{row.method}</span>
                  <span className={`shrink-0 rounded px-1 font-semibold ${tones.badge}`}>
                    {row.errorMessage ? "ERR" : row.status ?? "…"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg-base">{truncateUrl(row.url)}</span>
                  <span className="shrink-0 tabular-nums text-fg-base/40">
                    {typeof row.durationMs === "number" ? `${Math.round(row.durationMs)}ms` : "—"}
                  </span>
                </div>
                {/* Duration bar — relative to max duration in the set */}
                <div className="mt-1 h-0.5 w-full bg-black/[0.05] dark:bg-white/[0.05] overflow-hidden rounded-full">
                  <div
                    className={`h-full bg-gradient-to-r ${tones.barFrom} ${tones.barTo}`}
                    style={{ width: `${durationPct}%` }}
                  />
                </div>
                {row.errorMessage && (
                  <div className="mt-1 text-[10px] text-red-500/80 truncate" title={row.errorMessage}>
                    {row.errorMessage}
                  </div>
                )}
                {isExpanded && hasBodies && (
                  <div className="mt-2 ml-3 space-y-2 border-l border-line pl-3 text-[10px] font-sans">
                    {row.requestBody && (
                      <BodyBlock
                        title="Request body"
                        body={row.requestBody}
                        headers={row.requestHeaders}
                      />
                    )}
                    {row.responseBody && (
                      <BodyBlock
                        title="Response body"
                        body={row.responseBody}
                        headers={row.responseHeaders}
                      />
                    )}
                    {!row.requestBody && !row.responseBody && row.bodyOmittedReason && (
                      <p className="italic text-fg-base/40">
                        Body omitted: {row.bodyOmittedReason}
                      </p>
                    )}
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

// ── Presentational bits ──────────────────────────────────────────────────

/**
 * Pretty-prints a captured request/response body. JSON is already indented
 * by the SDK's `processBody`; we just render with a soft cap on display
 * height so a 100KB body doesn't blow up the panel layout.
 */
function BodyBlock({
  title,
  body,
  headers,
}: {
  title: string;
  body: { text: string; truncated: boolean; originalBytes: number };
  headers?: Record<string, string>;
}) {
  const [showHeaders, setShowHeaders] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(body.text).catch(() => {});
  };
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-fg-base/60">
        <span className="font-semibold uppercase tracking-wider text-[9px]">{title}</span>
        {body.truncated && (
          <span
            className="rounded-sm bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400"
            title={`Truncated from ${body.originalBytes.toLocaleString()} bytes`}
          >
            truncated
          </span>
        )}
        <span className="text-fg-base/40 tabular-nums">{body.originalBytes.toLocaleString()}B</span>
        {headers && Object.keys(headers).length > 0 && (
          <button
            type="button"
            onClick={() => setShowHeaders((v) => !v)}
            className="ml-auto rounded px-1 text-fg-base/50 hover:text-fg-base"
          >
            {showHeaders ? "Hide headers" : "Headers"}
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          className="rounded p-0.5 text-fg-base/50 hover:text-fg-base"
          aria-label="Copy body"
          title="Copy body to clipboard"
        >
          <Copy className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      {showHeaders && headers && (
        <pre className="mb-1 max-h-32 overflow-auto rounded bg-surface-inner/60 px-2 py-1 text-[10px] font-mono leading-snug text-fg-base/70">
          {Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n")}
        </pre>
      )}
      <pre className="max-h-64 overflow-auto rounded bg-surface-inner/60 px-2 py-1 text-[10px] font-mono leading-snug text-fg-base whitespace-pre-wrap break-all">
        {body.text}
      </pre>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: "error";
}) {
  const base = "rounded px-1.5 py-0.5 font-medium uppercase tracking-wider transition-colors";
  const activeClass = active
    ? tone === "error"
      ? "bg-red-500/15 text-red-600 dark:text-red-400"
      : "bg-inari-accent/15 text-inari-accent"
    : "text-fg-base/60 hover:text-fg-base";
  return (
    <button type="button" onClick={onClick} className={`${base} ${activeClass}`} aria-pressed={active}>
      {label}
    </button>
  );
}
