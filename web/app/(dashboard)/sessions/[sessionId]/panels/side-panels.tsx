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
import { BackendPanel, countBackendRows } from "./backend-panel";
import { AiPanel, countAiRows } from "./ai-panel";
import type { DetailedEvent } from "../derive-detailed-events";
import type { ResolvedError } from "@/lib/jobs/replay-stack-parser";
import type { BackendEvent, AiEvent } from "@/lib/fulltrace/manifest-aggregator";

type TabId = "console" | "network" | "backend" | "ai" | "errors" | "comments";
const TAB_KEY = "iw.replay.sidePanels.activeTab";
const COLLAPSE_KEY = "iw.replay.sidePanels.collapsed";
const VALID_TABS: TabId[] = ["console", "network", "backend", "ai", "errors", "comments"];

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
  /** VAR Q1 — Substrate I/O events for the Backend tab. Empty array hides
   *  the tab entirely so sessions without server-side recording don't get
   *  a misleading "0 events" tab. */
  backendEvents?: BackendEvent[];
  /** VAR Q1 — AI lifecycle events for the AI tab. Same hide-if-empty rule. */
  aiEvents?: AiEvent[];
  /** VAR Q1 — fired when a Backend or AI panel row is hovered (or
   *  un-hovered, with `null`). Drives the timeline canvas's causal-arrows
   *  overlay. */
  onHoverEvent?: (id: string | null) => void;
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
  backendEvents = [],
  aiEvents = [],
  onHoverEvent,
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
    if (stored && (VALID_TABS as string[]).includes(stored)) {
      setActiveTab(stored as TabId);
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
  const backendCounts = countBackendRows(backendEvents);
  const aiCounts = countAiRows(aiEvents);

  // FullTrace tabs (Backend, AI) only render when their data is non-empty.
  // Sessions without server-side recording or without linked alerts shouldn't
  // see a "0 events" tab — that's noise. The tab still exists in localStorage
  // so a session WITH data restores correctly.
  const showBackend = backendEvents.length > 0;
  const showAi = aiEvents.length > 0;

  // Defensive: if the persisted tab points at a hidden one, fall back to
  // the first visible tab so the panel doesn't render its content invisible.
  useEffect(() => {
    if (!hydrated) return;
    if (activeTab === "backend" && !showBackend) setActiveTab("console");
    if (activeTab === "ai" && !showAi) setActiveTab("console");
    if (activeTab === "comments" && !sessionId) setActiveTab("console");
  }, [hydrated, activeTab, showBackend, showAi, sessionId]);

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
      {showBackend && (
        <TabButton
          active={activeTab === "backend"}
          onClick={() => setActiveTab("backend")}
          label="Backend"
          count={backendCounts.total}
          alert={backendCounts.errors}
        />
      )}
      {showAi && (
        <TabButton
          active={activeTab === "ai"}
          onClick={() => setActiveTab("ai")}
          label="AI"
          count={aiCounts.total}
          alert={aiCounts.failures + aiCounts.alerts}
        />
      )}
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
        {showBackend && (
          <div
            className={`absolute inset-0 overflow-y-auto ${
              activeTab === "backend" ? "" : "invisible pointer-events-none"
            }`}
            aria-hidden={activeTab !== "backend"}
          >
            <BackendPanel events={backendEvents} currentMs={currentMs} onSeek={onSeek} onHoverEvent={onHoverEvent} />
          </div>
        )}
        {showAi && (
          <div
            className={`absolute inset-0 overflow-y-auto ${
              activeTab === "ai" ? "" : "invisible pointer-events-none"
            }`}
            aria-hidden={activeTab !== "ai"}
          >
            <AiPanel events={aiEvents} currentMs={currentMs} onSeek={onSeek} onHoverEvent={onHoverEvent} />
          </div>
        )}
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
