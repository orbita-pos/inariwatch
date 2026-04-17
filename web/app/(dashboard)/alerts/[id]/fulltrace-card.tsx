import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Film, Users, ArrowRight } from "lucide-react";
import { getAlertImpact } from "@/lib/services/alert-impact";

/**
 * FullTrace impact card on the alert detail page.
 *
 * Renders ONLY when the alert has a session_id correlated via the
 * X-IW-Session-Id header (Capture SDK v0.8+). Older alerts captured
 * before propagation get nothing — keeps the page clean for legacy data.
 *
 * Three pieces of information, in priority order:
 *   1. Sessions affected — distinct browser sessions that produced the
 *      same fingerprint. Tells you "is this a 1-off or a fleet event"
 *   2. Users affected — distinct end-users seen across those sessions
 *      (only counts identified users; anonymous traffic excluded)
 *   3. Deep link to the originating session — opens FullTrace player
 *      with the exact rrweb video, backend I/O, and AI events
 *
 * Server component — runs the impact query inline. Cheap (3 indexed
 * queries) so no client-side loading state needed; the alert page
 * already does its own parallel fetches.
 */
export async function FullTraceCard({ alertId }: { alertId: string }) {
  const impact = await getAlertImpact(alertId);

  // No session id = no FullTrace data. Hide entirely (not even a
  // skeleton or "no data" message — the alert page is dense enough).
  if (!impact.sessionId) return null;

  const sessionHref = `/sessions/${encodeURIComponent(impact.sessionId)}`;
  const showAggregates = impact.fingerprint && impact.sessionsAffected > 0;

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Film className="h-3.5 w-3.5 shrink-0 text-inari-accent" aria-hidden="true" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
            FullTrace
          </h3>
        </div>
        {showAggregates && (
          <span className="text-[10px] uppercase tracking-wider text-fg-base/50">
            same fingerprint, last 30d
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        {showAggregates ? (
          <div className="grid grid-cols-2 gap-3 mb-3">
            <ImpactStat
              label="Sessions affected"
              value={impact.sessionsAffected}
              icon={Film}
            />
            <ImpactStat
              label="Distinct users"
              value={impact.usersAffected}
              icon={Users}
              note={impact.usersAffected === 0 ? "no identified users" : undefined}
            />
          </div>
        ) : (
          <p className="text-xs text-fg-base/60 mb-3">
            This alert is the first sighting of its fingerprint — single-session impact.
          </p>
        )}

        <Link
          href={sessionHref}
          className="group flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-inner px-3 py-2 text-sm transition-colors hover:border-inari-accent/40 hover:bg-inari-accent/5"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Film className="h-4 w-4 shrink-0 text-inari-accent" aria-hidden="true" />
            <span className="truncate text-fg-strong">
              {impact.hasFullTrace
                ? "View session timeline"
                : "Open session (no replay video)"}
            </span>
          </div>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-base/60 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>

        {impact.hasFullTrace ? (
          <p className="mt-2 text-[10px] text-fg-base/50">
            Backend I/O · AI lifecycle · causal arrows on hover
          </p>
        ) : (
          <p className="mt-2 text-[10px] text-fg-base/50">
            Only metadata is available — no rrweb video was uploaded for this session.
          </p>
        )}
      </div>
    </div>
  );
}

function ImpactStat({
  label,
  value,
  icon: Icon,
  note,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  note?: string;
}) {
  return (
    <div className="rounded-lg bg-surface-inner px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-base/60">
        <Icon className="h-3 w-3" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tabular-nums text-fg-strong">{value}</span>
        {note && <span className="text-[10px] text-fg-base/50">{note}</span>}
      </div>
    </div>
  );
}
