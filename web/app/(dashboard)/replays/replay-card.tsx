import Link from "next/link";
import { formatRelativeTime } from "@/lib/utils";

interface ReplayCardProps {
  sessionId: string;
  startedAt: string;
  durationMs: number | null;
  browser: string | null;
  os: string | null;
  blockCount: number;
  totalBytes: number;
  urlsVisited: string[];
  errorCount: number;
  aiSummary: string | null;
}

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortBrowser(ua: string | null): string | null {
  if (!ua) return null;
  return ua.split(" ").slice(0, 2).join(" ");
}

export function ReplayCard(props: ReplayCardProps) {
  const href = `/replays/${encodeURIComponent(props.sessionId)}`;
  const urlPreview = props.urlsVisited.slice(0, 2).map((u) => {
    try {
      return new URL(u).pathname || u;
    } catch {
      return u;
    }
  }).join(" · ");

  return (
    <Link
      href={href}
      className="group block rounded-xl border border-line bg-surface px-4 py-3.5 transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.025]"
      aria-label={`Replay ${props.sessionId}`}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left column: identity + preview */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-fg-base/60">
              {props.sessionId.slice(0, 12)}…
            </span>
            {props.errorCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
                {props.errorCount} error{props.errorCount !== 1 ? "s" : ""}
              </span>
            )}
            {props.aiSummary && (
              <span className="inline-flex items-center rounded-md bg-inari-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-inari-accent">
                AI summary
              </span>
            )}
          </div>

          {props.aiSummary ? (
            <p className="mt-1 line-clamp-2 text-sm text-fg-base">{props.aiSummary}</p>
          ) : (
            urlPreview && (
              <p className="mt-1 truncate text-sm text-fg-base/80">{urlPreview}</p>
            )
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-base/60">
            {shortBrowser(props.browser) && <span>{shortBrowser(props.browser)}</span>}
            {props.os && <span>{props.os}</span>}
            <span>{formatDuration(props.durationMs)}</span>
            <span>{props.blockCount} block{props.blockCount !== 1 ? "s" : ""}</span>
            <span className="font-mono">{formatSize(props.totalBytes)}</span>
          </div>
        </div>

        {/* Right column: time */}
        <div className="shrink-0 text-right">
          <p className="font-mono text-xs text-fg-base/70 transition-colors group-hover:text-fg-base">
            {formatRelativeTime(new Date(props.startedAt))}
          </p>
        </div>
      </div>
    </Link>
  );
}
