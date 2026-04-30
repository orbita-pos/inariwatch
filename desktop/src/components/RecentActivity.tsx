import {
  AlertTriangle,
  FileEdit,
  GitBranch,
  Replace,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";

import { cn } from "@/lib/cn";

export type RecentActivityKind =
  | "fs_change"
  | "shell_event"
  | "git_event"
  | "replay_result"
  | "alert";

export interface RecentActivityEntry {
  id: string;
  kind: RecentActivityKind;
  /** Short, already-truncated summary (≤ 60 chars). */
  summary: string;
  /** Wall-clock ms when the event happened. Used for "3m ago". */
  timestampMs: number;
}

interface RecentActivityProps {
  entries: RecentActivityEntry[];
  onViewAll?: () => void;
}

const ICON_BY_KIND: Record<RecentActivityKind, LucideIcon> = {
  fs_change: FileEdit,
  shell_event: Terminal,
  git_event: GitBranch,
  replay_result: Replace,
  alert: AlertTriangle,
};

const COLOR_BY_KIND: Record<RecentActivityKind, string> = {
  fs_change: "text-[var(--muted)]",
  shell_event: "text-[var(--muted)]",
  git_event: "text-[var(--color-primary)]",
  replay_result: "text-[var(--color-ai)]",
  alert: "text-[var(--color-warning)]",
};

const MAX_ENTRIES = 5;

function formatRelative(now: number, then: number): string {
  const delta = Math.max(0, now - then);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Bottom feed in Mode 1 (idle). Renders the most-recent up-to-5 entries
 * delivered via `daemon:event`. Empty state: "Inari is watching" — never
 * a doom-y "no data found" because the dock's emotional register is
 * meditative, not anxious.
 */
export function RecentActivity({ entries, onViewAll }: RecentActivityProps) {
  const visible = useMemo(() => entries.slice(0, MAX_ENTRIES), [entries]);
  const now = Date.now();

  if (visible.length === 0) {
    return (
      <div
        data-testid="recent-activity-empty"
        className="text-center py-3 text-xs text-[var(--muted)]"
      >
        No activity yet — Inari is watching.
      </div>
    );
  }

  return (
    <div data-testid="recent-activity" className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[0.7rem] uppercase tracking-wider text-[var(--muted)]">
          Recent activity
        </span>
        {onViewAll ? (
          <button
            type="button"
            onClick={onViewAll}
            className={cn(
              "text-xs text-[var(--color-primary)]",
              "hover:underline focus:outline-none focus-visible:underline",
            )}
          >
            View all →
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1">
        {visible.map((entry) => {
          const Icon = ICON_BY_KIND[entry.kind];
          return (
            <li
              key={entry.id}
              className="flex items-center gap-2 text-xs"
              data-testid="recent-activity-entry"
            >
              <Icon
                className={cn("h-3.5 w-3.5 shrink-0", COLOR_BY_KIND[entry.kind])}
                aria-hidden
              />
              <span className="flex-1 truncate text-[var(--text)]">
                {entry.summary}
              </span>
              <span className="text-[var(--muted)] tabular-nums">
                {formatRelative(now, entry.timestampMs)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
