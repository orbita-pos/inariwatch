"use client";

/**
 * Side-panel container — wraps Console + Network panels in a shared
 * `PanelShell` with a tab strip in the header. Both panel bodies stay
 * mounted at all times; the inactive one is positioned absolutely and
 * made `invisible` + `pointer-events-none` so its scroll state and
 * filter selection survive tab switches (React component state is
 * preserved, browser scroll position stays at whatever the user last
 * scrolled to inside that panel).
 *
 * Active tab + collapsed state persist to localStorage so reopening
 * the replay viewer restores the exact panel configuration.
 */

import { useEffect, useState } from "react";
import { PanelShell } from "./panel-shell";
import { ConsolePanel, countConsoleRows } from "./console-panel";
import { NetworkPanel, countNetworkRows } from "./network-panel";
import { ErrorsPanel, countErrorRows } from "./errors-panel";
import { CommentsPanel, countCommentsUnresolved, type CommentRow } from "./comments-panel";
import type { DetailedEvent } from "../derive-detailed-events";
import type { ResolvedError } from "@/lib/jobs/replay-stack-parser";

type TabId = "console" | "network" | "errors" | "comments";
const TAB_KEY = "iw.replay.sidePanels.activeTab";
const COLLAPSE_KEY = "iw.replay.sidePanels.collapsed";

interface SidePanelsProps {
  events: DetailedEvent[];
  currentMs: number;
  onSeek: (ms: number) => void;
  /** Phase I.c — uncaught errors with parsed stack frames (from manifest). */
  errors?: ResolvedError[];
  repo?: { githubOwner: string; githubRepo: string; defaultBranch: string } | null;
  /** Day 4 — comments anchored to timestamps. Lifted state so the
   *  timeline-canvas markers and this panel share one fetched dataset. */
  sessionId?: string;
  comments?: CommentRow[];
  onCommentsChange?: (next: CommentRow[]) => void;
  currentUserId?: string | null;
}

export function SidePanels({
  events,
  currentMs,
  onSeek,
  errors = [],
  repo = null,
  sessionId,
  comments = [],
  onCommentsChange,
  currentUserId = null,
}: SidePanelsProps) {
  // SSR-safe: start with the default and hydrate from localStorage in an
  // effect. Using a `hydrated` *state* (not a ref) is critical — the write
  // effect captures its value at render time, so if it runs during the
  // initial commit before hydration completes it sees `hydrated === false`
  // and skips, avoiding the overwrite that a ref-based guard would race.
  const [activeTab, setActiveTab] = useState<TabId>("console");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(TAB_KEY) : null;
    if (stored === "console" || stored === "network" || stored === "errors" || stored === "comments") {
      setActiveTab(stored);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(TAB_KEY, activeTab);
    } catch {
      // localStorage quota / private mode — acceptable loss
    }
  }, [activeTab, hydrated]);

  const consoleCounts = countConsoleRows(events);
  const networkCounts = countNetworkRows(events);
  const errorCounts = countErrorRows(errors);
  const commentsUnresolved = countCommentsUnresolved(comments);

  const tabs = (
    <div className="flex items-center gap-0.5 rounded-md bg-surface-inner p-0.5">
      <TabButton
        active={activeTab === "console"}
        onClick={() => setActiveTab("console")}
        label="Console"
        count={consoleCounts.total}
        alert={consoleCounts.err}
      />
      <TabButton
        active={activeTab === "network"}
        onClick={() => setActiveTab("network")}
        label="Network"
        count={networkCounts.total}
        alert={networkCounts.failed}
      />
      <TabButton
        active={activeTab === "errors"}
        onClick={() => setActiveTab("errors")}
        label="Errors"
        count={errorCounts.total}
        alert={errorCounts.total}
      />
      {sessionId && (
        <TabButton
          active={activeTab === "comments"}
          onClick={() => setActiveTab("comments")}
          label="Comments"
          count={comments.length}
          alert={commentsUnresolved}
        />
      )}
    </div>
  );

  return (
    <PanelShell title="Inspect" persistKey={COLLAPSE_KEY} headerActions={tabs}>
      {/* Absolute stacking keeps inactive panel's scroll + filter state
          alive across tab switches. `invisible + pointer-events-none` is
          strictly better than `display: none` here: the layout + scroll
          context stay, React doesn't re-render children unnecessarily. */}
      <div className="relative h-full">
        <div
          className={`absolute inset-0 overflow-y-auto ${
            activeTab === "console" ? "" : "invisible pointer-events-none"
          }`}
          aria-hidden={activeTab !== "console"}
        >
          <ConsolePanel events={events} currentMs={currentMs} onSeek={onSeek} />
        </div>
        <div
          className={`absolute inset-0 overflow-y-auto ${
            activeTab === "network" ? "" : "invisible pointer-events-none"
          }`}
          aria-hidden={activeTab !== "network"}
        >
          <NetworkPanel events={events} currentMs={currentMs} onSeek={onSeek} />
        </div>
        <div
          className={`absolute inset-0 overflow-y-auto ${
            activeTab === "errors" ? "" : "invisible pointer-events-none"
          }`}
          aria-hidden={activeTab !== "errors"}
        >
          <ErrorsPanel errors={errors} currentMs={currentMs} onSeek={onSeek} repo={repo} />
        </div>
        {sessionId && onCommentsChange && (
          <div
            className={`absolute inset-0 overflow-hidden ${
              activeTab === "comments" ? "" : "invisible pointer-events-none"
            }`}
            aria-hidden={activeTab !== "comments"}
          >
            <CommentsPanel
              sessionId={sessionId}
              currentMs={currentMs}
              onSeek={onSeek}
              currentUserId={currentUserId}
              comments={comments}
              onCommentsChange={onCommentsChange}
            />
          </div>
        )}
      </div>
    </PanelShell>
  );
}

// ── Presentational bits ──────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  label,
  count,
  alert,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  /** Alert count — non-zero renders a red dot / count chip */
  alert: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
        active
          ? "bg-surface text-fg-strong shadow-sm"
          : "text-fg-base/60 hover:text-fg-base"
      }`}
    >
      <span>{label}</span>
      <span
        className={`rounded-sm px-1 text-[10px] tabular-nums ${
          alert > 0
            ? "bg-red-500/15 text-red-600 dark:text-red-400"
            : "bg-black/[0.05] dark:bg-white/[0.07] text-fg-base/60"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
