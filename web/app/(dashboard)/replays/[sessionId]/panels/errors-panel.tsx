"use client";

/**
 * Errors panel — renders the session's uncaught errors with structured
 * stack frames and "open in GitHub" links.
 *
 * Reads from `manifest.resolvedErrors` (populated by replay-analyze) so
 * the panel can stay synchronous and pure UI. Each error is grouped by
 * fingerprint and shows: message, count, first occurrence (clickable to
 * seek), and an expandable stack.
 */

import { useState } from "react";
import { AlertTriangle, ChevronRight, ExternalLink } from "lucide-react";
import { formatMs } from "../format-time";
import { buildGithubLink, type StackFrame, type ResolvedError } from "@/lib/jobs/replay-stack-parser";

interface ErrorsPanelProps {
  errors: ResolvedError[];
  currentMs: number;
  onSeek: (ms: number) => void;
  /** GitHub repo for building per-frame deep links. Null when no repo
   *  is connected — frames render as plain text in that case. */
  repo: { githubOwner: string; githubRepo: string; defaultBranch: string } | null;
}

export function countErrorRows(errors: ResolvedError[]): { total: number; instances: number } {
  let instances = 0;
  for (const e of errors) instances += e.count;
  return { total: errors.length, instances };
}

export function ErrorsPanel({ errors, currentMs, onSeek, repo }: ErrorsPanelProps) {
  if (errors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 px-4 text-center text-fg-base/40">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        <p className="text-xs">No uncaught errors</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {errors.map((err) => (
        <ErrorRow
          key={err.fingerprint}
          err={err}
          currentMs={currentMs}
          onSeek={onSeek}
          repo={repo}
        />
      ))}
    </ul>
  );
}

function ErrorRow({
  err,
  currentMs,
  onSeek,
  repo,
}: {
  err: ResolvedError;
  currentMs: number;
  onSeek: (ms: number) => void;
  repo: ErrorsPanelProps["repo"];
}) {
  // First error expanded by default; rest collapsed. Once the user toggles
  // we never override their choice.
  const [open, setOpen] = useState(true);
  const isActive = currentMs >= err.firstTimestamp - 50 && currentMs < err.firstTimestamp + 250;

  return (
    <li
      className={`group transition-colors ${isActive ? "bg-red-500/[0.04]" : ""}`}
      data-idx={err.fingerprint}
    >
      {/* Header: chevron + message + meta. Whole row is clickable to expand,
          but the timestamp is its own button to seek without expanding. */}
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse stack" : "Expand stack"}
          className="mt-0.5 shrink-0 rounded p-0.5 text-fg-base/40 hover:text-fg-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/40"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
        </button>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-fg-strong leading-snug break-words">
            {err.message || "(no message)"}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-fg-base/50">
            <button
              type="button"
              onClick={() => onSeek(err.firstTimestamp)}
              className="font-mono tabular-nums hover:text-inari-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/40"
              title="Seek to first occurrence"
            >
              {formatMs(err.firstTimestamp)}
            </button>
            {err.count > 1 && (
              <span className="rounded-sm bg-red-500/15 px-1 text-red-600 dark:text-red-400">
                ×{err.count}
              </span>
            )}
            <span className="font-mono opacity-60" title="Fingerprint">
              {err.fingerprint.slice(0, 10)}
            </span>
          </div>
        </div>
      </div>

      {/* Stack — only rendered when expanded */}
      {open && err.frames.length > 0 && (
        <ol className="ml-6 mb-2 mr-3 space-y-0.5 border-l border-line pl-2">
          {err.frames.map((f, i) => (
            <FrameRow key={i} frame={f} repo={repo} />
          ))}
        </ol>
      )}
      {open && err.frames.length === 0 && (
        <p className="ml-7 mb-2 text-[10px] italic text-fg-base/40">
          (no stack captured)
        </p>
      )}
    </li>
  );
}

function FrameRow({
  frame,
  repo,
}: {
  frame: StackFrame;
  repo: ErrorsPanelProps["repo"];
}) {
  // Prefer mapped frames once the source-map worker fills them in.
  const display = frame.mapped
    ? { source: frame.mapped.file, line: frame.mapped.line, col: frame.mapped.col, fnName: frame.mapped.fnName ?? frame.fnName }
    : { source: frame.source, line: frame.line, col: frame.col, fnName: frame.fnName };

  const ghLink = repo
    ? buildGithubLink({
        source: display.source,
        line: display.line,
        githubOwner: repo.githubOwner,
        githubRepo: repo.githubRepo,
        branch: repo.defaultBranch,
      })
    : null;

  // Show only the basename + last folder so the frame fits on one line.
  const shortPath = (() => {
    try {
      const u = new URL(display.source);
      const parts = u.pathname.split("/").filter(Boolean);
      return parts.slice(-2).join("/") || u.hostname;
    } catch {
      const parts = display.source.split("/").filter(Boolean);
      return parts.slice(-2).join("/") || display.source;
    }
  })();

  const FrameInner = (
    <span className="flex items-baseline gap-1.5 text-[10px] leading-relaxed">
      {display.fnName && (
        <span className="font-mono text-fg-base/80">{display.fnName}</span>
      )}
      <span className="font-mono text-fg-base/55 truncate" title={display.source}>
        {shortPath}
      </span>
      <span className="font-mono text-fg-base/40 tabular-nums shrink-0">
        :{display.line}{display.col != null ? `:${display.col}` : ""}
      </span>
      {frame.mapped && (
        <span
          className="rounded-sm bg-emerald-500/15 px-1 text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
          title="Resolved via source map"
        >
          mapped
        </span>
      )}
    </span>
  );

  return (
    <li className="flex items-baseline gap-1">
      {ghLink ? (
        <a
          href={ghLink}
          target="_blank"
          rel="noopener noreferrer"
          className="group/link flex min-w-0 flex-1 items-center gap-1 hover:text-fg-strong"
          title={`Open ${shortPath}:${display.line} on GitHub`}
        >
          {FrameInner}
          <ExternalLink
            className="h-2.5 w-2.5 shrink-0 text-fg-base/30 opacity-0 transition-opacity group-hover/link:opacity-100"
            aria-hidden="true"
          />
        </a>
      ) : (
        <span className="min-w-0 flex-1">{FrameInner}</span>
      )}
    </li>
  );
}
