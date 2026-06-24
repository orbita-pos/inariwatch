/**
 * Git Context card — surfaces the commit SHA + branch that shipped
 * when the error fired.
 *
 * The data comes from `@inariwatch/capture` v0.9+ via
 * `alerts.correlationData.git`. Fields:
 *   commit:    full SHA (we show first 7)
 *   branch:    git branch name
 *   message:   first line of the commit message (pre-scrubbed for secrets)
 *   timestamp: ISO8601 of the commit
 *   dirty:     true if the build had uncommitted changes
 *
 * Renders nothing when the payload is missing or malformed — keeps the
 * alert page clean for older integrations that don't provide git info.
 */

import { GitCommit, GitBranch, Clock, AlertTriangle } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

interface GitPayload {
  commit?: unknown;
  branch?: unknown;
  message?: unknown;
  timestamp?: unknown;
  dirty?: unknown;
}

export interface GitContextCardProps {
  /** Raw correlationData value — the card narrows it and renders
   *  nothing when it isn't a valid git payload. */
  data: unknown;
  /** Optional owner/repo for rendering a commit link. When absent the
   *  SHA is shown as inline text (not a link). */
  repo?: string | null;
}

export function GitContextCard({ data, repo }: GitContextCardProps) {
  const git = narrow(data);
  if (!git) return null;

  const shortSha = git.commit.slice(0, 7);
  const commitUrl = repo ? `https://github.com/${repo}/commit/${git.commit}` : null;
  const committedAt = git.timestamp ? safeDate(git.timestamp) : null;

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <GitCommit className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            Git Context
          </h3>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-fg-base/50">
          at time of error
        </span>
      </div>

      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          {commitUrl ? (
            <a
              href={commitUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-surface-inner px-2 py-0.5 font-mono text-xs text-fg-strong hover:text-inari-accent hover:underline"
            >
              {shortSha}
            </a>
          ) : (
            <span className="rounded bg-surface-inner px-2 py-0.5 font-mono text-xs text-fg-strong">
              {shortSha}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-xs text-fg-base/70">
            <GitBranch className="h-3 w-3" aria-hidden />
            {git.branch ?? "unknown"}
          </span>
          {git.dirty && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
              dirty
            </span>
          )}
        </div>

        {git.message && (
          <p className="text-xs text-fg-base/80 line-clamp-2">{git.message}</p>
        )}

        {committedAt && (
          <p className="inline-flex items-center gap-1 text-[10px] text-fg-base/50">
            <Clock className="h-3 w-3" aria-hidden />
            committed {formatRelativeTime(committedAt)}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Narrow the runtime payload ────────────────────────────────────────────

interface NarrowedGit {
  commit: string;
  branch: string | null;
  message: string | null;
  timestamp: string | null;
  dirty: boolean;
}

function narrow(data: unknown): NarrowedGit | null {
  if (!data || typeof data !== "object") return null;
  const g = data as GitPayload;
  const commit = typeof g.commit === "string" && g.commit.length >= 7 ? g.commit : null;
  if (!commit) return null;
  return {
    commit,
    branch: typeof g.branch === "string" ? g.branch : null,
    message: typeof g.message === "string" && g.message ? g.message : null,
    timestamp: typeof g.timestamp === "string" ? g.timestamp : null,
    dirty: g.dirty === true,
  };
}

function safeDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}
