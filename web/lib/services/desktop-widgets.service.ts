/**
 * Desktop widget services — single source of truth for the 5 new
 * /api/desktop/* read-only endpoints consumed by Inari Live's right-side
 * dashboard panel (v0.3 Dashboard Phase A).
 *
 * Rules (per the Phase A handoff):
 *  - No AI calls — pure data fetches.
 *  - Each function takes a list of project IDs (already scoped to the
 *    authenticated user) and returns a typed payload.
 *  - Reuses lower-level helpers (lib/on-call.ts, alerts service, etc.)
 *    where possible. Anything new lives here so the route handlers stay
 *    thin.
 */

import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  alerts,
  communityFixes,
  errorPatterns,
  onCallSchedules,
  onCallSlots,
  onCallOverrides,
  projects,
  uptimeChecks,
  uptimeMonitors,
  users,
} from "@/lib/db";

// ── Uptime ───────────────────────────────────────────────────────────────────

export type UptimeSummary = {
  monitors: Array<{
    id: string;
    name: string | null;
    url: string;
    isDown: boolean;
    consecutiveFailures: number;
    lastCheckedAt: string | null;
    lastResponseTimeMs: number | null;
  }>;
  /** Number of monitors currently down (consecutiveFailures > 0). */
  downCount: number;
  /** Number of monitors total. */
  total: number;
  /** Average response time across the last check of each monitor. */
  avgResponseMs: number | null;
};

export async function getUptimeSummary(
  projectIds: string[]
): Promise<UptimeSummary> {
  if (projectIds.length === 0) {
    return { monitors: [], downCount: 0, total: 0, avgResponseMs: null };
  }

  const monitors = await db
    .select({
      id: uptimeMonitors.id,
      name: uptimeMonitors.name,
      url: uptimeMonitors.url,
      isDown: uptimeMonitors.isDown,
      consecutiveFailures: uptimeMonitors.consecutiveFailures,
      lastCheckedAt: uptimeMonitors.lastCheckedAt,
    })
    .from(uptimeMonitors)
    .where(
      and(
        inArray(uptimeMonitors.projectId, projectIds),
        eq(uptimeMonitors.isActive, true)
      )
    );

  // Pull the most recent response time per monitor in one round-trip.
  const monitorIds = monitors.map((m) => m.id);
  const lastChecks =
    monitorIds.length === 0
      ? []
      : ((await db.execute(sql`
            SELECT DISTINCT ON (monitor_id)
              monitor_id, response_time_ms
            FROM uptime_checks
            WHERE monitor_id = ANY(${monitorIds})
            ORDER BY monitor_id, checked_at DESC
          `)).rows as { monitor_id: string; response_time_ms: number | null }[]);

  const responseByMonitor = new Map(
    lastChecks.map((r) => [r.monitor_id, r.response_time_ms])
  );

  const samples = lastChecks
    .map((r) => r.response_time_ms)
    .filter((v): v is number => typeof v === "number");
  const avg =
    samples.length > 0
      ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
      : null;

  return {
    monitors: monitors.map((m) => ({
      id: m.id,
      name: m.name,
      url: m.url,
      isDown: m.isDown,
      consecutiveFailures: m.consecutiveFailures,
      lastCheckedAt: m.lastCheckedAt
        ? new Date(m.lastCheckedAt).toISOString()
        : null,
      lastResponseTimeMs: responseByMonitor.get(m.id) ?? null,
    })),
    downCount: monitors.filter((m) => m.consecutiveFailures > 0).length,
    total: monitors.length,
    avgResponseMs: avg,
  };
}

// ── Deploys ──────────────────────────────────────────────────────────────────
//
// We don't store deploy history in our own DB — Vercel is the source. To keep
// the panel useful without per-call Vercel API spend, we surface the most
// recent deploy-related ALERTS (sourceIntegrations contains "vercel") which
// the Vercel poller already writes. Each row maps to a deploy event the user
// can drill into via the existing dashboard.

export type DeploySummary = {
  deploys: Array<{
    id: string;
    projectName: string;
    title: string;
    severity: string;
    state: "success" | "failed" | "building" | "unknown";
    createdAt: string;
  }>;
  failedCount: number;
};

const DEPLOY_TITLE_RE = /\b(deploy|deployment|build)\b/i;

export async function getDeploysSummary(
  projectIds: string[],
  limit = 8
): Promise<DeploySummary> {
  if (projectIds.length === 0) return { deploys: [], failedCount: 0 };

  // Prefer alerts whose sourceIntegrations includes vercel/github actions and
  // whose title looks deploy-related. Drizzle's `inArray` doesn't help with
  // an array column, so we filter in JS after fetching the recent slice.
  const recent = await db
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      title: alerts.title,
      severity: alerts.severity,
      sourceIntegrations: alerts.sourceIntegrations,
      isResolved: alerts.isResolved,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .where(inArray(alerts.projectId, projectIds))
    .orderBy(desc(alerts.createdAt))
    .limit(120);

  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const projectMap = new Map(projectRows.map((p) => [p.id, p.name]));

  const filtered = recent
    .filter((a) => {
      const sources = (a.sourceIntegrations ?? []) as string[];
      const fromDeploy =
        sources.some((s) => s === "vercel" || s === "github") ||
        DEPLOY_TITLE_RE.test(a.title);
      return fromDeploy;
    })
    .slice(0, limit);

  const deploys = filtered.map((a) => {
    const t = a.title.toLowerCase();
    let state: "success" | "failed" | "building" | "unknown" = "unknown";
    if (t.includes("fail") || a.severity === "critical") state = "failed";
    else if (t.includes("succe") || a.isResolved) state = "success";
    else if (t.includes("build")) state = "building";
    return {
      id: a.id,
      projectName: projectMap.get(a.projectId) ?? "?",
      title: a.title,
      severity: a.severity,
      state,
      createdAt: new Date(a.createdAt).toISOString(),
    };
  });

  return {
    deploys,
    failedCount: deploys.filter((d) => d.state === "failed").length,
  };
}

// ── On-call ──────────────────────────────────────────────────────────────────

export type OncallStatus = {
  schedules: Array<{
    projectId: string;
    projectName: string;
    scheduleName: string;
    timezone: string;
    primary: { userId: string; name: string | null; email: string | null } | null;
    secondary: { userId: string; name: string | null; email: string | null } | null;
    /** True if the primary slot is currently covered by an override row. */
    hasActiveOverride: boolean;
  }>;
  /** Total primary-on-call assignments across all projects. */
  totalAssignments: number;
};

export async function getOncallStatus(
  projectIds: string[]
): Promise<OncallStatus> {
  if (projectIds.length === 0) {
    return { schedules: [], totalAssignments: 0 };
  }

  const schedules = await db
    .select({
      id: onCallSchedules.id,
      projectId: onCallSchedules.projectId,
      name: onCallSchedules.name,
      timezone: onCallSchedules.timezone,
    })
    .from(onCallSchedules)
    .where(inArray(onCallSchedules.projectId, projectIds));

  if (schedules.length === 0) return { schedules: [], totalAssignments: 0 };

  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const projectMap = new Map(projectRows.map((p) => [p.id, p.name]));

  // Resolve who is currently on-call by re-using the same time arithmetic
  // that lib/on-call.ts uses. We could `await getCurrentOnCallUserId(p,1)`
  // for each schedule, but doing it in a single SQL pass keeps the panel
  // round-trip predictable.
  const now = new Date();

  const schedulesWith = await Promise.all(
    schedules.map(async (s) => {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: s.timezone,
        hour: "numeric",
        hour12: false,
        weekday: "short",
      });
      const parts = formatter.formatToParts(now);
      const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
      const hour = parseInt(
        parts.find((p) => p.type === "hour")?.value ?? "0",
        10
      );
      const dayMap: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      const currentDay = dayMap[weekdayStr] ?? 0;

      const resolveLevel = async (
        level: number
      ): Promise<{
        userId: string;
        viaOverride: boolean;
      } | null> => {
        const [override] = await db
          .select({ userId: onCallOverrides.userId })
          .from(onCallOverrides)
          .where(
            and(
              eq(onCallOverrides.scheduleId, s.id),
              eq(onCallOverrides.level, level),
              sql`${onCallOverrides.startsAt} <= ${now}`,
              sql`${onCallOverrides.endsAt} >= ${now}`
            )
          )
          .limit(1);
        if (override) return { userId: override.userId, viaOverride: true };

        const slots = await db
          .select()
          .from(onCallSlots)
          .where(
            and(
              eq(onCallSlots.scheduleId, s.id),
              eq(onCallSlots.level, level)
            )
          );
        for (const slot of slots) {
          const dayInRange =
            slot.dayStart <= slot.dayEnd
              ? currentDay >= slot.dayStart && currentDay <= slot.dayEnd
              : currentDay >= slot.dayStart || currentDay <= slot.dayEnd;
          if (!dayInRange) continue;
          const hourInRange =
            slot.hourStart <= slot.hourEnd
              ? hour >= slot.hourStart && hour <= slot.hourEnd
              : hour >= slot.hourStart || hour <= slot.hourEnd;
          if (!hourInRange) continue;
          return { userId: slot.userId, viaOverride: false };
        }
        return null;
      };

      const [primary, secondary] = await Promise.all([
        resolveLevel(1),
        resolveLevel(2),
      ]);

      const userIds = [primary?.userId, secondary?.userId].filter(
        (v): v is string => Boolean(v)
      );
      const userRows = userIds.length
        ? await db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
            })
            .from(users)
            .where(inArray(users.id, userIds))
        : [];
      const userMap = new Map(userRows.map((u) => [u.id, u]));

      const primaryUser = primary
        ? {
            userId: primary.userId,
            name: userMap.get(primary.userId)?.name ?? null,
            email: userMap.get(primary.userId)?.email ?? null,
          }
        : null;
      const secondaryUser = secondary
        ? {
            userId: secondary.userId,
            name: userMap.get(secondary.userId)?.name ?? null,
            email: userMap.get(secondary.userId)?.email ?? null,
          }
        : null;

      return {
        projectId: s.projectId,
        projectName: projectMap.get(s.projectId) ?? "?",
        scheduleName: s.name,
        timezone: s.timezone,
        primary: primaryUser,
        secondary: secondaryUser,
        hasActiveOverride: primary?.viaOverride ?? false,
      };
    })
  );

  return {
    schedules: schedulesWith,
    totalAssignments: schedulesWith.filter((s) => s.primary !== null).length,
  };
}

// ── Community trending ───────────────────────────────────────────────────────

export type TrendingFix = {
  id: string;
  patternId: string;
  patternTitle: string;
  fixApproach: string;
  fixDescription: string;
  successCount: number;
  failureCount: number;
  /** Success rate as a percentage rounded to whole %. */
  successRate: number;
  totalApplications: number;
};

/**
 * Top-N trending community fixes by recent activity. NOT scoped to user
 * projects (community knowledge is shared across all workspaces). Auth still
 * required: the caller has to be a desktop-token holder, but the data is
 * non-sensitive.
 */
export async function getCommunityTrending(
  limit = 8
): Promise<TrendingFix[]> {
  const rows = await db
    .select({
      id: communityFixes.id,
      patternId: communityFixes.patternId,
      fixApproach: communityFixes.fixApproach,
      fixDescription: communityFixes.fixDescription,
      successCount: communityFixes.successCount,
      failureCount: communityFixes.failureCount,
      totalApplications: communityFixes.totalApplications,
      patternText: errorPatterns.patternText,
      patternCategory: errorPatterns.category,
    })
    .from(communityFixes)
    .leftJoin(errorPatterns, eq(communityFixes.patternId, errorPatterns.id))
    .orderBy(desc(communityFixes.totalApplications))
    .limit(limit);

  return rows.map((r) => {
    const total = r.successCount + r.failureCount;
    const rate = total > 0 ? Math.round((r.successCount / total) * 100) : 0;
    // Pattern texts can be long stack-trace excerpts — clip for the chip.
    const text = r.patternText ?? "(untitled pattern)";
    const patternTitle =
      text.length > 80 ? text.slice(0, 77).trimEnd() + "…" : text;
    return {
      id: r.id,
      patternId: r.patternId,
      patternTitle,
      fixApproach: r.fixApproach,
      fixDescription: r.fixDescription,
      successCount: r.successCount,
      failureCount: r.failureCount,
      successRate: rate,
      totalApplications: r.totalApplications,
    };
  });
}

// ── Status summary ───────────────────────────────────────────────────────────

export type StatusSummary = {
  /** "operational" | "degraded" | "outage" — derived from the live signals. */
  state: "operational" | "degraded" | "outage";
  /** Counts in the last 24h (alerts) / now (uptime). */
  alertsCritical24h: number;
  alertsWarning24h: number;
  monitorsDown: number;
  monitorsTotal: number;
  /** Project count for context. */
  projectCount: number;
  /** ISO timestamp of the most recent alert across all surfaces. */
  lastAlertAt: string | null;
};

export async function getStatusSummary(
  projectIds: string[]
): Promise<StatusSummary> {
  if (projectIds.length === 0) {
    return {
      state: "operational",
      alertsCritical24h: 0,
      alertsWarning24h: 0,
      monitorsDown: 0,
      monitorsTotal: 0,
      projectCount: 0,
      lastAlertAt: null,
    };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [counts, monitorRows, lastAlert] = await Promise.all([
    db
      .select({
        severity: alerts.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(alerts)
      .where(
        and(
          inArray(alerts.projectId, projectIds),
          gt(alerts.createdAt, since)
        )
      )
      .groupBy(alerts.severity),
    db
      .select({
        consecutiveFailures: uptimeMonitors.consecutiveFailures,
      })
      .from(uptimeMonitors)
      .where(
        and(
          inArray(uptimeMonitors.projectId, projectIds),
          eq(uptimeMonitors.isActive, true)
        )
      ),
    db
      .select({ createdAt: alerts.createdAt })
      .from(alerts)
      .where(inArray(alerts.projectId, projectIds))
      .orderBy(desc(alerts.createdAt))
      .limit(1),
  ]);

  const critical =
    counts.find((c) => c.severity === "critical")?.count ?? 0;
  const warning = counts.find((c) => c.severity === "warning")?.count ?? 0;

  const monitorsDown = monitorRows.filter((m) => m.consecutiveFailures > 0)
    .length;
  const monitorsTotal = monitorRows.length;

  let state: "operational" | "degraded" | "outage" = "operational";
  if (critical > 0 || monitorsDown > 0) state = "outage";
  else if (warning > 0) state = "degraded";

  return {
    state,
    alertsCritical24h: critical,
    alertsWarning24h: warning,
    monitorsDown,
    monitorsTotal,
    projectCount: projectIds.length,
    lastAlertAt: lastAlert[0]
      ? new Date(lastAlert[0].createdAt).toISOString()
      : null,
  };
}
