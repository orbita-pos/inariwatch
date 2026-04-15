import Link from "next/link";
import { ChevronRight } from "lucide-react";
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
  /** Phase E — populated by replay-analyze. 0 means the analyzer hasn't
   *  run yet OR there was no detected frustration. */
  rageCount?: number;
  deadCount?: number;
  /** Phase F — end-user identity. Page resolves the privacy toggle and
   *  passes `null` for `endUserEmail` when the project hashes emails. */
  endUserId?: string | null;
  endUserEmail?: string | null;
  endUserEmailHash?: string | null;
  /** Phase G — Web Vitals snapshot. Card shows the WORST rating only. */
  webVitals?: Record<string, { value: number; rating: "good" | "needs-improvement" | "poor" }>;
}

/** Pick the worst-rated vital + its name. Returns null when the snapshot
 *  is empty or only contains "good" metrics (then the badge is omitted). */
function worstVital(
  vitals: ReplayCardProps["webVitals"],
): { name: string; rating: "needs-improvement" | "poor" } | null {
  if (!vitals) return null;
  let worstName: string | null = null;
  let worstRank = 0;
  const rank = (r: string) => (r === "poor" ? 2 : r === "needs-improvement" ? 1 : 0);
  for (const [name, v] of Object.entries(vitals)) {
    const r = rank(v.rating);
    if (r > worstRank) {
      worstRank = r;
      worstName = name;
    }
  }
  if (!worstName || worstRank === 0) return null;
  return { name: worstName, rating: worstRank === 2 ? "poor" : "needs-improvement" };
}

/**
 * Overall card severity — drives the 3px left rail colour so reviewers
 * can triage a page of 50 sessions by scanning the left edge. Priority:
 * errors + poor vital → red; rage/dead/slow vital → amber; clean → none.
 */
function cardSeverity(props: {
  errorCount: number;
  rageCount?: number;
  deadCount?: number;
  worstVitalRating: "needs-improvement" | "poor" | null;
}): "critical" | "warning" | "ok" {
  if (props.errorCount > 0 || props.worstVitalRating === "poor" || (props.rageCount ?? 0) >= 2) {
    return "critical";
  }
  if ((props.rageCount ?? 0) > 0 || (props.deadCount ?? 0) > 0 || props.worstVitalRating === "needs-improvement") {
    return "warning";
  }
  return "ok";
}

/**
 * Choose what to display for the end user. Email beats id beats short hash
 * beats nothing — always returns a stable label per session. Centralised
 * here so the player header / list card render the same string.
 */
function endUserLabel(props: Pick<ReplayCardProps, "endUserEmail" | "endUserId" | "endUserEmailHash">): string | null {
  if (props.endUserEmail) return props.endUserEmail;
  if (props.endUserId) return props.endUserId;
  if (props.endUserEmailHash) return `User …${props.endUserEmailHash.slice(-6)}`;
  return null;
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
  // "Mozilla/5.0 (Windows NT 10.0; Win64; x64)..." → "Chrome 120" style
  const match = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/);
  if (match) return match[0].replace("/", " ").replace(/\.\d+.*$/, "");
  return ua.split(" ").slice(0, 2).join(" ");
}

export function ReplayCard(props: ReplayCardProps) {
  const href = `/replays/${encodeURIComponent(props.sessionId)}`;
  const userLabel = endUserLabel(props);
  const worst = worstVital(props.webVitals);
  const severity = cardSeverity({
    errorCount: props.errorCount,
    rageCount: props.rageCount,
    deadCount: props.deadCount,
    worstVitalRating: worst?.rating ?? null,
  });
  const urlPreview = props.urlsVisited.slice(0, 2).map((u) => {
    try {
      return new URL(u).pathname || u;
    } catch {
      return u;
    }
  }).join(" · ");

  // Left rail color — accent-based so it matches other dashboard severity
  // conventions (red=critical, amber=warning, subtle line=ok).
  const railColor =
    severity === "critical"
      ? "bg-red-500"
      : severity === "warning"
        ? "bg-amber-500"
        : "bg-line";

  return (
    <Link
      href={href}
      className="group relative flex gap-3 overflow-hidden rounded-xl border border-line bg-surface pr-4 transition-all hover:border-line-medium hover:bg-black/[0.02] dark:hover:bg-white/[0.02] focus-visible:ring-2 focus-visible:ring-inari-accent/40 focus-visible:outline-none"
      aria-label={`Replay ${props.sessionId}`}
    >
      {/* Severity rail — scannable at a glance even in a 50-card list */}
      <div className={`w-[3px] shrink-0 ${railColor}`} aria-hidden="true" />

      <div className="flex flex-1 items-start gap-4 py-3">
        <div className="min-w-0 flex-1">
          {/* Row 1 — identity: user first (primary), then AI summary or URL preview */}
          <div className="flex items-baseline gap-2">
            {userLabel ? (
              <span
                className="truncate text-sm font-semibold text-fg-strong"
                title={userLabel}
              >
                {userLabel}
              </span>
            ) : (
              <span className="text-sm font-semibold text-fg-strong/70">Anonymous session</span>
            )}
            {props.aiSummary && (
              <span
                className="hidden shrink-0 items-center rounded-full bg-inari-accent/10 px-1.5 text-[10px] font-medium uppercase tracking-wide text-inari-accent sm:inline-flex"
                title="This session has an AI-generated summary"
              >
                AI
              </span>
            )}
          </div>

          {/* Row 2 — one-liner: AI summary if present, otherwise URL preview */}
          {(props.aiSummary || urlPreview) && (
            <p className="mt-0.5 line-clamp-1 text-sm text-fg-base/80">
              {props.aiSummary ?? urlPreview}
            </p>
          )}

          {/* Row 3 — signal badges (only rendered when signal present) */}
          {(props.errorCount > 0 || worst || (props.rageCount ?? 0) > 0 || (props.deadCount ?? 0) > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {props.errorCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
                  {props.errorCount} error{props.errorCount !== 1 ? "s" : ""}
                </span>
              )}
              {worst && (
                <span
                  className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                    worst.rating === "poor"
                      ? "bg-red-500/10 text-red-600 dark:text-red-400"
                      : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  }`}
                  title="Worst Web Vital — click into the session to see all five"
                >
                  {worst.name} {worst.rating === "poor" ? "poor" : "slow"}
                </span>
              )}
              {(props.rageCount ?? 0) > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
                  title="Rage clicks — user repeatedly clicked the same target in frustration"
                >
                  {props.rageCount} rage
                </span>
              )}
              {(props.deadCount ?? 0) > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
                  title="Dead clicks — user clicked but nothing happened"
                >
                  {props.deadCount} dead
                </span>
              )}
            </div>
          )}

          {/* Row 4 — meta: quieter, technical. Session id last because it's
              the least actionable piece of info on the card. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-base/55">
            {shortBrowser(props.browser) && <span>{shortBrowser(props.browser)}</span>}
            {props.os && <span>{props.os}</span>}
            <span>{formatDuration(props.durationMs)}</span>
            <span>{props.blockCount} block{props.blockCount !== 1 ? "s" : ""}</span>
            <span className="font-mono">{formatSize(props.totalBytes)}</span>
            <span className="font-mono text-fg-base/40">{props.sessionId.slice(0, 10)}…</span>
          </div>
        </div>

        {/* Right column — time + hover affordance */}
        <div className="flex shrink-0 items-start gap-2 pt-0.5">
          <p className="font-mono text-[11px] text-fg-base/70 transition-colors group-hover:text-fg-base">
            {formatRelativeTime(new Date(props.startedAt))}
          </p>
          <ChevronRight
            className="mt-0.5 h-3.5 w-3.5 text-fg-base/30 transition-all group-hover:translate-x-0.5 group-hover:text-fg-base/70"
            aria-hidden="true"
          />
        </div>
      </div>
    </Link>
  );
}
