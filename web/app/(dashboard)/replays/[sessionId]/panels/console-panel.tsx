"use client";

/**
 * Replay-synced console log panel BODY (without the outer PanelShell).
 * The `SidePanels` container mounts this inside a shared shell alongside
 * NetworkPanel — see `side-panels.tsx` for the tab-switching wrapper.
 *
 * Features:
 *   - Level filter (errors / warnings / all) at the top, sticky on scroll
 *   - Current-playback highlight (row whose timestamp is the latest
 *     at-or-before `currentMs` gets an accent bar + auto-scrolls into view)
 *   - Click-to-seek (clicking a row jumps playback to that timestamp)
 *   - Color-coded levels (error red, warn amber, else muted)
 */

import { useMemo, useRef, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { DetailedEvent } from "../derive-detailed-events";
import { findActiveIndex } from "../derive-detailed-events";
import { formatMs } from "../format-time";

type LogRow =
  | Extract<DetailedEvent, { kind: "console" }>
  | (Extract<DetailedEvent, { kind: "error" }> & { level: "error" });

type LevelFilter = "all" | "error" | "warn";

interface ConsolePanelProps {
  events: DetailedEvent[];
  currentMs: number;
  onSeek: (ms: number) => void;
}

/** Row counts so the parent tab strip can show "Console (3)" badges. */
export function countConsoleRows(events: DetailedEvent[]): {
  total: number;
  err: number;
  warn: number;
} {
  let total = 0;
  let err = 0;
  let warn = 0;
  for (const e of events) {
    if (e.kind === "console") {
      total++;
      if (e.level === "error") err++;
      else if (e.level === "warn") warn++;
    } else if (e.kind === "error") {
      total++;
      err++;
    }
  }
  return { total, err, warn };
}

function buildRows(events: DetailedEvent[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const e of events) {
    if (e.kind === "console") {
      rows.push(e);
    } else if (e.kind === "error") {
      rows.push({
        kind: "error",
        timestamp: e.timestamp,
        fingerprint: e.fingerprint,
        message: e.message,
        level: "error",
      });
    }
  }
  return rows;
}

export function ConsolePanel({ events, currentMs, onSeek }: ConsolePanelProps) {
  const [level, setLevel] = useState<LevelFilter>("all");

  const rows = useMemo(() => buildRows(events), [events]);

  const filtered = useMemo(() => {
    if (level === "all") return rows;
    return rows.filter((r) => {
      const rowLevel = r.kind === "error" ? "error" : r.level;
      return rowLevel === level;
    });
  }, [rows, level]);

  const activeIndex = useMemo(() => findActiveIndex(filtered, currentMs), [filtered, currentMs]);

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const node = listRef.current.querySelector<HTMLLIElement>(`[data-idx="${activeIndex}"]`);
    if (node) node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  const counts = useMemo(() => countConsoleRows(events), [events]);

  return (
    <div className="flex h-full flex-col">
      {/* Filter chips — sticky so they remain visible as the user scrolls */}
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-line bg-surface px-3 py-1.5 text-[10px]">
        <FilterChip active={level === "all"} onClick={() => setLevel("all")} label={`All ${counts.total}`} />
        <FilterChip
          active={level === "error"}
          onClick={() => setLevel("error")}
          label={`Errors ${counts.err}`}
          tone="error"
        />
        <FilterChip
          active={level === "warn"}
          onClick={() => setLevel("warn")}
          label={`Warn ${counts.warn}`}
          tone="warn"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-fg-base/50">
          {rows.length === 0 ? "No console output captured." : "No logs match the active filter."}
        </div>
      ) : (
        <ul ref={listRef} className="divide-y divide-line text-[11px] font-mono">
          {filtered.map((row, i) => {
            const isActive = i === activeIndex;
            const isError = row.kind === "error" || row.level === "error";
            const isWarn = row.kind === "console" && row.level === "warn";
            return (
              <li
                key={`${row.timestamp}-${i}`}
                data-idx={i}
                className={`relative cursor-pointer px-3 py-1.5 transition-colors ${
                  isActive ? "bg-inari-accent/5" : "hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                } ${
                  isError
                    ? "text-red-600 dark:text-red-400"
                    : isWarn
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-fg-base"
                }`}
                onClick={() => onSeek(row.timestamp)}
                title={`${formatMs(row.timestamp)} — click to seek`}
              >
                {isActive && (
                  <span className="absolute left-0 top-0 h-full w-0.5 bg-inari-accent" aria-hidden="true" />
                )}
                <div className="flex items-start gap-2">
                  <LevelIcon level={isError ? "error" : isWarn ? "warn" : "info"} />
                  <span className="shrink-0 text-fg-base/40 tabular-nums">{formatMs(row.timestamp)}</span>
                  <span className="min-w-0 break-words">{row.message}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Presentational bits ──────────────────────────────────────────────────

function FilterChip({
  active,
  onClick,
  label,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: "error" | "warn";
}) {
  const base = "rounded px-1.5 py-0.5 font-medium uppercase tracking-wider transition-colors";
  const activeClass = active
    ? tone === "error"
      ? "bg-red-500/15 text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-inari-accent/15 text-inari-accent"
    : "text-fg-base/60 hover:text-fg-base";
  return (
    <button type="button" onClick={onClick} className={`${base} ${activeClass}`} aria-pressed={active}>
      {label}
    </button>
  );
}

function LevelIcon({ level }: { level: "error" | "warn" | "info" }) {
  const cls = "h-3 w-3 shrink-0 mt-0.5";
  if (level === "error") return <AlertCircle className={cls} aria-label="error" />;
  if (level === "warn") return <AlertTriangle className={cls} aria-label="warning" />;
  return <Info className={`${cls} opacity-50`} aria-label="info" />;
}
