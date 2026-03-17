/**
 * Anomaly Detection Engine
 *
 * Runs after every cron poll cycle. Compares current patterns against
 * historical baselines and creates proactive alerts before things fail.
 *
 * Detects:
 * 1. Alert frequency spike  — sudden surge vs 30-day hourly baseline
 * 2. Repeating failure loop — same alert type firing 3+ times in 24h
 * 3. Integration health     — consecutive errors on an integration
 * 4. Silent project         — project with history but no recent activity
 *
 * Design invariants (production-grade):
 * - Titles are STABLE (no dynamic numbers) so 24h dedup in createAlertIfNew works correctly.
 * - Dynamic details (ratios, counts) go in the body only.
 * - Auto-resolves open anomaly alerts whose condition is no longer active each cycle.
 */

import { db, alerts, projectIntegrations } from "@/lib/db";
import { inArray, sql, and, eq, gt, like } from "drizzle-orm";
import type { NewAlert } from "@/lib/db";

type AnomalyResult = Omit<NewAlert, "projectId"> & { projectId: string };

// ── 1. Alert frequency spike ─────────────────────────────────────────────────

async function detectAlertSpikes(projectIds: string[]): Promise<AnomalyResult[]> {
  const results: AnomalyResult[] = [];

  // Per-project: avg hourly alert count over last 30 days (baseline)
  const baseline = await db.execute<{ project_id: string; avg_per_hour: number }>(sql`
    SELECT
      project_id,
      AVG(hourly_count)::float AS avg_per_hour
    FROM (
      SELECT
        project_id,
        DATE_TRUNC('hour', created_at) AS hour,
        COUNT(*) AS hourly_count
      FROM alerts
      WHERE project_id = ANY(${projectIds})
        AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY project_id, DATE_TRUNC('hour', created_at)
    ) sub
    GROUP BY project_id
  `);

  // Per-project: alert count in the last 2 hours
  const recent = await db.execute<{ project_id: string; recent_count: number }>(sql`
    SELECT project_id, COUNT(*) AS recent_count
    FROM alerts
    WHERE project_id = ANY(${projectIds})
      AND created_at > NOW() - INTERVAL '2 hours'
    GROUP BY project_id
  `);

  const baselineMap = new Map(baseline.rows.map((r) => [r.project_id, Number(r.avg_per_hour)]));
  const recentMap   = new Map(recent.rows.map((r) => [r.project_id, Number(r.recent_count)]));

  for (const projectId of projectIds) {
    const avg    = baselineMap.get(projectId) ?? 0;
    const count2h = recentMap.get(projectId) ?? 0;

    // Skip projects with no history or no recent activity
    if (avg < 0.5 || count2h < 3) continue;

    const ratio = count2h / avg;

    if (ratio >= 5) {
      results.push({
        projectId,
        severity: "critical",
        // FIX 1: stable title — ratio goes in body only
        title: `Anomaly: alert surge detected`,
        body: `This project generated ${count2h} alerts in the last 2 hours — ${Math.round(ratio)}× higher than the 30-day hourly average (${avg.toFixed(1)}/hr).\n\nThis spike may indicate a cascading failure or a misconfigured integration. Review recent alerts for a common root cause.`,
        sourceIntegrations: [],
        isRead: false,
        isResolved: false,
      });
    } else if (ratio >= 3) {
      results.push({
        projectId,
        severity: "warning",
        // FIX 1: stable title
        title: `Anomaly: alert rate elevated`,
        body: `This project generated ${count2h} alerts in the last 2 hours — ${Math.round(ratio)}× higher than the 30-day hourly average (${avg.toFixed(1)}/hr).\n\nMonitor closely — this may escalate.`,
        sourceIntegrations: [],
        isRead: false,
        isResolved: false,
      });
    }
  }

  return results;
}

// ── 2. Repeating failure loop ─────────────────────────────────────────────────

async function detectRepeatingFailures(projectIds: string[]): Promise<AnomalyResult[]> {
  const results: AnomalyResult[] = [];

  // Find alert titles that have appeared 3+ times in the last 24h (unresolved)
  const repeated = await db.execute<{ project_id: string; alert_title: string; occurrences: number }>(sql`
    SELECT
      project_id,
      title AS alert_title,
      COUNT(*) AS occurrences
    FROM alerts
    WHERE project_id = ANY(${projectIds})
      AND created_at > NOW() - INTERVAL '24 hours'
      AND is_resolved = false
    GROUP BY project_id, title
    HAVING COUNT(*) >= 3
  `);

  for (const row of repeated.rows) {
    const occurrences = Number(row.occurrences);
    results.push({
      projectId: row.project_id,
      severity: "warning",
      // FIX 1: embed the specific alert title (stable identifier per failure type),
      // but keep occurrence count out of the title
      title: `Anomaly: recurring failure — ${row.alert_title.slice(0, 60)}`,
      body: `The alert "${row.alert_title}" has fired ${occurrences} times in the last 24 hours and remains unresolved.\n\nThis is a repeating failure loop. Consider using AI Remediation to fix the root cause permanently.`,
      sourceIntegrations: [],
      isRead: false,
      isResolved: false,
    });
  }

  return results;
}

// ── 3. Integration health degradation ────────────────────────────────────────

async function detectIntegrationErrors(projectIds: string[]): Promise<AnomalyResult[]> {
  const results: AnomalyResult[] = [];

  const unhealthy = await db
    .select({
      projectId:     projectIntegrations.projectId,
      service:       projectIntegrations.service,
      errorCount:    projectIntegrations.errorCount,
      lastCheckedAt: projectIntegrations.lastCheckedAt,
    })
    .from(projectIntegrations)
    .where(
      and(
        inArray(projectIntegrations.projectId, projectIds),
        eq(projectIntegrations.isActive, true),
        gt(projectIntegrations.errorCount, 5)
      )
    );

  for (const integ of unhealthy) {
    results.push({
      projectId: integ.projectId,
      severity: "warning",
      // FIX 1: stable title — error count goes in body only
      title: `Anomaly: ${integ.service} integration failing`,
      body: `The ${integ.service} integration has failed ${integ.errorCount} consecutive times${
        integ.lastCheckedAt ? ` (last attempt: ${integ.lastCheckedAt.toISOString().slice(0, 16)})` : ""
      }.\n\nMonitoring for this integration may be disrupted. Check the token/credentials in Integrations settings.`,
      sourceIntegrations: [integ.service],
      isRead: false,
      isResolved: false,
    });
  }

  return results;
}

// ── 4. Silent project (unusual inactivity) ───────────────────────────────────

async function detectSilentProjects(projectIds: string[]): Promise<AnomalyResult[]> {
  const results: AnomalyResult[] = [];

  // FIX 2: correct SQL using a daily-count subquery for the baseline period.
  // Previous version averaged a 0/1 row indicator * 24, which is mathematically wrong.
  // This version averages actual daily alert counts from the 30-day baseline window,
  // then counts separately for the last 7 days.
  const activityProfile = await db.execute<{
    project_id: string;
    avg_daily: number;
    last_7d_count: number;
  }>(sql`
    WITH baseline AS (
      SELECT
        project_id,
        AVG(daily_count)::float AS avg_daily
      FROM (
        SELECT
          project_id,
          DATE_TRUNC('day', created_at) AS day,
          COUNT(*) AS daily_count
        FROM alerts
        WHERE project_id = ANY(${projectIds})
          AND created_at >= NOW() - INTERVAL '37 days'
          AND created_at <  NOW() - INTERVAL '7 days'
        GROUP BY project_id, DATE_TRUNC('day', created_at)
      ) daily_counts
      GROUP BY project_id
    ),
    recent AS (
      SELECT project_id, COUNT(*) AS last_7d_count
      FROM alerts
      WHERE project_id = ANY(${projectIds})
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY project_id
    )
    SELECT
      b.project_id,
      b.avg_daily,
      COALESCE(r.last_7d_count, 0) AS last_7d_count
    FROM baseline b
    LEFT JOIN recent r ON r.project_id = b.project_id
  `);

  for (const row of activityProfile.rows) {
    const avgDaily = Number(row.avg_daily);
    const last7d   = Number(row.last_7d_count);

    // Only flag if the project historically averaged >2 alerts/day but went silent
    if (avgDaily >= 2 && last7d === 0) {
      results.push({
        projectId: row.project_id,
        severity: "info",
        // FIX 1: stable title — avg count goes in body only
        title: `Anomaly: silent project detected`,
        body: `This project normally generates ~${avgDaily.toFixed(0)} alerts per day but has had none in the last 7 days.\n\nThis could mean:\n• Your integrations are healthy — great!\n• Monitoring is disconnected and not detecting real issues\n\nVerify your integrations are still receiving data.`,
        sourceIntegrations: [],
        isRead: false,
        isResolved: false,
      });
    }
  }

  return results;
}

// ── Auto-resolve stale anomaly alerts ─────────────────────────────────────────

/**
 * FIX 3: Resolve open anomaly alerts whose condition is no longer active.
 *
 * Matches by projectId + title (both stable after Fix 1).
 * If an anomaly alert is open but its condition cleared (e.g. spike dropped,
 * integration recovered, project resumed activity), mark it resolved.
 */
async function autoResolveStaleAnomalies(
  projectIds: string[],
  currentAnomalies: AnomalyResult[]
): Promise<void> {
  const openAnomalies = await db
    .select({ id: alerts.id, projectId: alerts.projectId, title: alerts.title })
    .from(alerts)
    .where(
      and(
        inArray(alerts.projectId, projectIds),
        eq(alerts.isResolved, false),
        like(alerts.title, "Anomaly:%")
      )
    );

  if (openAnomalies.length === 0) return;

  // Build a set of currently-active anomaly keys (projectId + title)
  const activeKeys = new Set(
    currentAnomalies.map((a) => `${a.projectId}::${a.title}`)
  );

  const toResolve = openAnomalies
    .filter((a) => !activeKeys.has(`${a.projectId}::${a.title}`))
    .map((a) => a.id);

  if (toResolve.length === 0) return;

  await db
    .update(alerts)
    .set({ isResolved: true })
    .where(inArray(alerts.id, toResolve));
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Run all anomaly detectors and return currently-active anomalies.
 */
export async function detectAnomalies(projectIds: string[]): Promise<AnomalyResult[]> {
  if (projectIds.length === 0) return [];

  const [spikes, repeating, integErrors, silent] = await Promise.all([
    detectAlertSpikes(projectIds).catch(() => [] as AnomalyResult[]),
    detectRepeatingFailures(projectIds).catch(() => [] as AnomalyResult[]),
    detectIntegrationErrors(projectIds).catch(() => [] as AnomalyResult[]),
    detectSilentProjects(projectIds).catch(() => [] as AnomalyResult[]),
  ]);

  return [...spikes, ...repeating, ...integErrors, ...silent];
}

/**
 * Full anomaly engine — call this from the cron job.
 *
 * 1. Detect current active anomalies
 * 2. Auto-resolve alerts whose condition cleared (Fix 3)
 * 3. Return current anomalies → caller passes each to createAlertIfNew
 */
export async function runAnomalyEngine(projectIds: string[]): Promise<AnomalyResult[]> {
  if (projectIds.length === 0) return [];

  const current = await detectAnomalies(projectIds);
  await autoResolveStaleAnomalies(projectIds, current).catch(() => {});
  return current;
}
