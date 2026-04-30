import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { CommandPalette } from "@/components/CommandPalette";
import {
  QuickActions,
  type QuickActionKind,
} from "@/components/QuickActions";
import {
  RecentActivity,
  type RecentActivityEntry,
  type RecentActivityKind,
} from "@/components/RecentActivity";
import { KbdHint } from "@/components/ui";
import {
  fetchIndexStats,
  hideDock,
  openMainWindow,
  resolveActiveRepo,
  type ActiveRepoSummary,
  type IndexStats,
} from "@/lib/dock-ipc";
import { onDaemonEvent, type DaemonEvent } from "@/lib/ipc";
import { useChat } from "@/lib/store/chat";

const FS_CHANGE_WINDOW_MS = 60_000;
const STATUS_LABELS: Record<DockStatus, string> = {
  idle: "idle",
  typing: "typing",
  thinking: "thinking",
};

type DockStatus = "idle" | "typing" | "thinking";
type PaletteIntent = "default" | "search" | "fix";

interface DockIdleProps {
  /**
   * Override hooks for testing — let the test render the screen without
   * spinning up the IPC layer. In production, defaults handle everything.
   */
  initialRepo?: ActiveRepoSummary | null;
  initialIndexStats?: IndexStats | null;
  initialActivity?: RecentActivityEntry[];
  /** When provided, replaces the live `daemon:event` subscription. */
  subscribeEvents?: (handler: (event: DaemonEvent) => void) => () => void;
}

function summarizeFsChange(event: DaemonEvent): RecentActivityEntry | null {
  const change = (event as Record<string, unknown>)["change"];
  let summary = "filesystem changed";
  if (change && typeof change === "object") {
    const entry = change as Record<string, unknown>;
    const kind = typeof entry.kind === "string" ? entry.kind : "change";
    const path =
      typeof entry.path === "string"
        ? entry.path.replace(/^.*[\\/]/, "")
        : "";
    summary = path ? `${kind}: ${path}` : kind;
  }
  return {
    id: `fs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "fs_change",
    summary: summary.slice(0, 60),
    timestampMs: Date.now(),
  };
}

function summarizeShellEvent(event: DaemonEvent): RecentActivityEntry {
  const command = (event as Record<string, unknown>)["command"];
  const exit = (event as Record<string, unknown>)["exit_code"];
  const cmd =
    typeof command === "string" ? command : "shell command";
  const exitLabel = typeof exit === "number" && exit !== 0 ? ` (exit ${exit})` : "";
  return {
    id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "shell_event",
    summary: `${cmd}${exitLabel}`.slice(0, 60),
    timestampMs: Date.now(),
  };
}

function summarizeReplay(event: DaemonEvent): RecentActivityEntry {
  const summary = (event as Record<string, unknown>)["summary"];
  let body = "replay completed";
  if (summary && typeof summary === "object") {
    const s = summary as Record<string, unknown>;
    const sev = typeof s.severity === "string" ? s.severity : "match";
    const mod = typeof s.affected_module === "string" ? s.affected_module : "";
    body = mod ? `replay ${sev}: ${mod}` : `replay ${sev}`;
  }
  return {
    id: `rp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "replay_result",
    summary: body.slice(0, 60),
    timestampMs: Date.now(),
  };
}

const KIND_TO_ACTIVITY: Record<string, RecentActivityKind> = {
  fs_change: "fs_change",
  shell_event: "shell_event",
  git_event: "git_event",
  replay_result: "replay_result",
  alert: "alert",
};

function pickHandler(
  event: DaemonEvent,
): RecentActivityEntry | null {
  if (typeof event.kind !== "string") return null;
  const mapped = KIND_TO_ACTIVITY[event.kind];
  if (!mapped) return null;
  if (event.kind === "fs_change") return summarizeFsChange(event);
  if (event.kind === "shell_event") return summarizeShellEvent(event);
  if (event.kind === "replay_result") return summarizeReplay(event);
  // Generic fallback for git_event / alert — push a 1-liner derived from
  // the discriminator so the user at least sees activity is happening.
  return {
    id: `${event.kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: mapped,
    summary: event.kind.replace(/_/g, " "),
    timestampMs: Date.now(),
  };
}

function formatIndexedAge(ms: number | null): string {
  if (ms == null) return "never";
  const delta = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Dock Mode 1 — idle.
 *
 * 4 stacked sections (top input/status row, middle quick-actions grid,
 * bottom recent-activity feed, footer stats). All async reads degrade
 * gracefully: missing repo / IPC stub / no events all render the
 * meditative empty state, never an error toast.
 */
export function DockIdle({
  initialRepo = null,
  initialIndexStats = null,
  initialActivity = [],
  subscribeEvents,
}: DockIdleProps) {
  const [repo, setRepo] = useState<ActiveRepoSummary | null>(initialRepo);
  const [indexStats, setIndexStats] = useState<IndexStats | null>(
    initialIndexStats,
  );
  const [activity, setActivity] = useState<RecentActivityEntry[]>(initialActivity);
  const [recentFsTimestamps, setRecentFsTimestamps] = useState<number[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIntent, setPaletteIntent] = useState<PaletteIntent>("default");
  const inputValue = useChat((s) => s.inputValue);
  const setInputValue = useChat((s) => s.setInputValue);
  const sendMessage = useChat((s) => s.sendMessage);
  const startConversation = useChat((s) => s.startConversation);
  const inputRef = useRef<HTMLInputElement>(null);

  // Resolve repo + index stats once on mount. If the test passed
  // initial values, skip the IPC.
  useEffect(() => {
    let cancelled = false;
    if (initialRepo === null) {
      resolveActiveRepo().then((r) => {
        if (!cancelled) setRepo(r);
      });
    }
    if (initialIndexStats === null) {
      fetchIndexStats().then((s) => {
        if (!cancelled) setIndexStats(s);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [initialRepo, initialIndexStats]);

  // Subscribe to daemon events. Tests inject `subscribeEvents` for
  // determinism; production uses the real `onDaemonEvent` listener.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const onEvent = (event: DaemonEvent) => {
      const entry = pickHandler(event);
      if (entry) {
        setActivity((prev) => [entry, ...prev].slice(0, 5));
      }
      if (event.kind === "fs_change") {
        setRecentFsTimestamps((prev) => {
          const cutoff = Date.now() - FS_CHANGE_WINDOW_MS;
          return [...prev.filter((t) => t > cutoff), Date.now()];
        });
      }
    };

    if (subscribeEvents) {
      unlisten = subscribeEvents(onEvent);
    } else {
      onDaemonEvent(onEvent).then((u) => {
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      }).catch(() => {
        // No daemon — fine, dock stays idle.
      });
    }

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [subscribeEvents]);

  // Derive the change count from the rolling 60s window.
  const changes = useMemo(() => {
    const cutoff = Date.now() - FS_CHANGE_WINDOW_MS;
    return recentFsTimestamps.filter((t) => t > cutoff).length;
  }, [recentFsTimestamps]);

  const status: DockStatus =
    inputValue.length > 0 ? "typing" : "idle";

  const onQuickAction = (kind: QuickActionKind) => {
    if (kind === "chat") {
      startConversation();
      return;
    }
    setPaletteIntent(kind === "search" ? "search" : "fix");
    setPaletteOpen(true);
  };

  const onSubmitInput = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    sendMessage(inputValue);
  };

  // ESC closes the dock when the palette isn't open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !paletteOpen) {
        hideDock();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteOpen]);

  const repoLabel = repo ? `⏵ ${repo.name}` : "⏵ no repo selected";
  const branchLabel = repo?.branch ? ` · ${repo.branch}` : "";
  const changesLabel = repo ? ` · ${changes} change${changes === 1 ? "" : "s"}` : "";
  const repoHint = repo
    ? `${STATUS_LABELS[status]}`
    : "drop one in main window";

  const symbolText = indexStats
    ? `${indexStats.symbolCount.toLocaleString()} symbols`
    : "0 symbols";
  const indexedText = `indexed ${formatIndexedAge(indexStats?.lastIndexedAtMs ?? null)}`;

  return (
    <div data-testid="dock-idle" className="flex flex-col h-full">
      {/* Section 1 — top: input + repo status */}
      <div className="px-4 pt-4 pb-3 border-b border-[var(--border)] flex flex-col gap-2">
        <form onSubmit={onSubmitInput} className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[var(--color-ai)]" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => setPaletteOpen(true)}
            placeholder="Ask Inari, search this repo, or fix the latest error"
            aria-label="Inari prompt"
            data-testid="dock-input"
            className="flex-1 h-9 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--muted)] outline-none border-none"
          />
          <KbdHint>⌘ K</KbdHint>
        </form>
        <div
          className="text-xs text-[var(--muted)] flex items-center gap-1"
          data-testid="dock-status-row"
        >
          <span>
            {repoLabel}
            {branchLabel}
            {changesLabel}
          </span>
          <span aria-hidden>·</span>
          <span>{repoHint}</span>
        </div>
      </div>

      {/* Section 2 — mid: quick actions */}
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <QuickActions onSelect={onQuickAction} />
      </div>

      {/* Section 3 — bottom: recent activity */}
      <div className="flex-1 px-4 py-3 overflow-auto">
        <RecentActivity
          entries={activity}
          onViewAll={() => openMainWindow("activity")}
        />
      </div>

      {/* Section 4 — footer: stats */}
      <footer
        className="flex items-center justify-between px-4 h-9 border-t border-[var(--border)] text-xs text-[var(--muted)]"
        data-testid="dock-idle-footer"
      >
        <span>
          Inari knows {symbolText} · {indexedText}
        </span>
        <span>
          <KbdHint>ESC</KbdHint> to close
        </span>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        intent={paletteIntent}
      />
    </div>
  );
}
