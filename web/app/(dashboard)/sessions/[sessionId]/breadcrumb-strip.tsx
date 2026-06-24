"use client";

/**
 * Horizontal strip of URL chips above the viewport. Each chip represents
 * one meta-event navigation (rrweb type=4, either at session start or
 * after a SPA route change). Chips are paired with the NEXT nav event
 * to compute dwell time so reviewers can see "user spent 12s on /cart".
 *
 * Clicking a chip seeks playback to that URL's start time.
 */

import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { DetailedEvent } from "./derive-detailed-events";
import { findActiveIndex } from "./derive-detailed-events";
import { formatMs } from "./format-time";

interface BreadcrumbStripProps {
  events: DetailedEvent[];
  currentMs: number;
  onSeek: (ms: number) => void;
  /** Session total duration for the last chip's dwell time calculation. */
  durationMs: number;
}

interface Crumb {
  startMs: number;
  endMs: number;
  dwellMs: number;
  href: string;
  /** Path-only for display; we keep full href for the title tooltip. */
  displayPath: string;
}

function buildCrumbs(events: DetailedEvent[], durationMs: number): Crumb[] {
  const navs = events.filter((e): e is Extract<DetailedEvent, { kind: "nav" }> => e.kind === "nav");

  // De-duplicate: if two consecutive metas carry the same href (common on
  // checkoutEveryNms re-emits), collapse them into a single crumb. That
  // way the strip doesn't show "/cart /cart /cart" for a 3-minute session.
  const deduped: typeof navs = [];
  for (const n of navs) {
    const last = deduped[deduped.length - 1];
    if (!last || last.href !== n.href) deduped.push(n);
  }

  return deduped.map((n, i) => {
    const next = deduped[i + 1];
    const endMs = next ? next.timestamp : Math.max(n.timestamp, durationMs);
    return {
      startMs: n.timestamp,
      endMs,
      dwellMs: Math.max(0, endMs - n.timestamp),
      href: n.href,
      displayPath: pathOnly(n.href),
    };
  });
}

function pathOnly(href: string): string {
  try {
    const u = new URL(href);
    const p = u.pathname + u.search;
    return p.length > 1 ? p : "/";
  } catch {
    return href;
  }
}

export function BreadcrumbStrip({ events, currentMs, onSeek, durationMs }: BreadcrumbStripProps) {
  const crumbs = useMemo(() => buildCrumbs(events, durationMs), [events, durationMs]);

  // Which crumb covers `currentMs`? Binary search on the crumb-start
  // timestamps keeps this cheap on sessions with hundreds of route
  // changes. Reuses the same util as the panel lists.
  const activeIndex = useMemo(
    () => findActiveIndex(crumbs.map((c) => ({ kind: "nav" as const, timestamp: c.startMs, href: c.href })), currentMs),
    [crumbs, currentMs],
  );

  if (crumbs.length === 0) {
    // Graceful fallback: sessions without any captured URLs (rare — means
    // rrweb never emitted a meta event) don't show the strip at all.
    return null;
  }

  return (
    <div
      role="navigation"
      aria-label="Session URL breadcrumbs"
      data-testid="breadcrumb-strip"
      className="flex items-center gap-0.5 border-b border-line bg-surface px-4 py-1.5 overflow-x-auto"
    >
      {crumbs.map((c, i) => {
        const isActive = i === activeIndex;
        const isLast = i === crumbs.length - 1;
        return (
          <div key={`${c.startMs}-${c.href}`} className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => onSeek(c.startMs)}
              title={`${c.href}\n${formatMs(c.startMs)} → ${formatMs(c.endMs)} (${formatMs(c.dwellMs)})`}
              className={`group flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                isActive
                  ? "bg-inari-accent/10 text-inari-accent"
                  : "text-fg-base/70 hover:bg-surface-inner hover:text-fg-base"
              }`}
            >
              <span className="font-mono truncate max-w-[160px]" aria-label="URL path">
                {c.displayPath}
              </span>
              <span className="shrink-0 text-[10px] text-fg-base/40 tabular-nums">
                {formatMs(c.dwellMs)}
              </span>
            </button>
            {!isLast && (
              <ChevronRight className="h-3 w-3 shrink-0 text-fg-base/30" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
}
