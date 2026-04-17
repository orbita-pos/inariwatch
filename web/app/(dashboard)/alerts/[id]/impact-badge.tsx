import { TrendingUp } from "lucide-react";
import { getBusinessImpact, impactLevelLabel, type ImpactLevel } from "@/lib/services/business-impact";
import { getAlertImpact } from "@/lib/services/alert-impact";
import { db, alerts } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * Business impact badge — small inline card showing how prioritized this
 * alert is on the team's queue. Reads two signals:
 *   1. Heuristic surface match (revenue / auth / admin / data ...)
 *   2. Affected-users count from getAlertImpact
 *
 * Server component. Two cheap DB calls. Renders nothing on degraded
 * states (alert missing, scoring returned 0) so the page stays clean
 * for low-noise alerts.
 *
 * Tooltip shows the matched factors so customers can see WHY a score is
 * what it is — same pattern as Sentry's "Why is this alerting?" rationale.
 */
export async function ImpactBadge({ alertId }: { alertId: string }) {
  const [alert] = await db
    .select({
      title: alerts.title,
      body: alerts.body,
      severity: alerts.severity,
      sourceIntegrations: alerts.sourceIntegrations,
    })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return null;

  const userImpact = await getAlertImpact(alertId);
  const impact = getBusinessImpact(alert, userImpact.usersAffected);

  // No factors matched + no user signal = nothing meaningful to show.
  // Keep the page calm rather than render "Impact: LOW (0)" everywhere.
  if (impact.score === 0) return null;

  return (
    <div className={`rounded-xl border px-4 py-3 ${LEVEL_BORDER[impact.level]} ${LEVEL_BG[impact.level]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <TrendingUp className={`h-4 w-4 shrink-0 ${LEVEL_TEXT[impact.level]}`} aria-hidden="true" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wider text-fg-base/60">Business impact</span>
              <span className={`text-xs font-bold ${LEVEL_TEXT[impact.level]}`}>
                {impactLevelLabel(impact.level)}
              </span>
              <span className="text-[10px] tabular-nums text-fg-base/50">({impact.score}/100)</span>
            </div>
            {impact.factors.length > 0 && (
              <p className="mt-1 text-[11px] text-fg-base/70 line-clamp-1">
                {impact.factors.slice(0, 3).map((f) => f.evidence.replace(/^[^:]+:\s*/, "")).join(" · ")}
              </p>
            )}
          </div>
        </div>
        {/* Affected-users chip on the right when we have a non-zero count.
            Helps customers correlate "high score because real users hit it". */}
        {userImpact.usersAffected > 0 && (
          <div className="shrink-0 text-right">
            <div className="text-lg font-bold tabular-nums text-fg-strong">
              {userImpact.usersAffected}
            </div>
            <div className="text-[9px] uppercase tracking-wider text-fg-base/60">
              user{userImpact.usersAffected === 1 ? "" : "s"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const LEVEL_BORDER: Record<ImpactLevel, string> = {
  critical: "border-red-500/40",
  high:     "border-amber-500/40",
  medium:   "border-blue-500/30",
  low:      "border-line",
};

const LEVEL_BG: Record<ImpactLevel, string> = {
  critical: "bg-red-500/[0.06]",
  high:     "bg-amber-500/[0.06]",
  medium:   "bg-blue-500/[0.05]",
  low:      "bg-surface",
};

const LEVEL_TEXT: Record<ImpactLevel, string> = {
  critical: "text-red-500",
  high:     "text-amber-600 dark:text-amber-400",
  medium:   "text-blue-600 dark:text-blue-400",
  low:      "text-fg-base/60",
};
