/**
 * Anomaly Pre-Aggregation Job — runs hourly.
 *
 * Replaces the expensive 30-day alert scan that ran every 2 minutes.
 *
 * What it does:
 *   1. Aggregates alert counts by project + hour for the last 2 hours
 *   2. Inserts/updates into alert_hourly_counts rollup table
 *   3. Runs spike detection against the rollup (fast: ~720 rows max)
 *   4. Creates anomaly alerts if spikes detected
 *
 * Old approach: scan millions of alert rows every 2 min (O(n) where n = all alerts × 30 days)
 * New approach: hourly rollup + read 720 rows (O(1) relative to alert volume)
 */

import { db, alerts, projects } from "../db.js";
import { eq, gte, sql } from "drizzle-orm";

/**
 * Pre-aggregate alert counts and detect anomalies.
 */
export async function runAnomalyAggregation(): Promise<{ aggregated: number; anomalies: number }> {
  let aggregated = 0;
  let anomalies = 0;

  try {
    // 1. Upsert hourly counts for the last 2 hours (covers gaps from missed runs)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const result = await db.execute(sql`
      INSERT INTO alert_hourly_counts (project_id, hour, alert_count)
      SELECT
        project_id,
        date_trunc('hour', created_at) AS hour,
        count(*)::int AS alert_count
      FROM alerts
      WHERE created_at >= ${twoHoursAgo}
      GROUP BY project_id, date_trunc('hour', created_at)
      ON CONFLICT (project_id, hour)
      DO UPDATE SET alert_count = EXCLUDED.alert_count, updated_at = now()
    `);

    aggregated = Number(result.rowCount ?? 0);

    // 2. Spike detection: compare current hour vs 30-day hourly average
    const currentHour = new Date();
    currentHour.setMinutes(0, 0, 0);

    const spikes = await db.execute(sql`
      WITH current_counts AS (
        SELECT project_id, alert_count
        FROM alert_hourly_counts
        WHERE hour = date_trunc('hour', now())
      ),
      baselines AS (
        SELECT project_id, avg(alert_count) AS avg_count, stddev(alert_count) AS std_count
        FROM alert_hourly_counts
        WHERE hour >= now() - interval '30 days'
          AND hour < date_trunc('hour', now())
        GROUP BY project_id
        HAVING count(*) >= 24
      )
      SELECT
        c.project_id,
        c.alert_count AS current,
        round(b.avg_count::numeric, 1) AS average,
        round(b.std_count::numeric, 1) AS stddev
      FROM current_counts c
      JOIN baselines b ON c.project_id = b.project_id
      WHERE c.alert_count > b.avg_count + 3 * GREATEST(b.std_count, 1)
    `);

    // 3. Create anomaly alerts for spikes
    for (const spike of spikes.rows as { project_id: string; current: number; average: number; stddev: number }[]) {
      try {
        await db.insert(alerts).values({
          projectId: spike.project_id,
          severity: "warning",
          title: `📈 Alert spike detected: ${spike.current} alerts this hour (avg: ${spike.average})`,
          body: `Anomaly detected: ${spike.current} alerts in the current hour, which is ${Math.round(((spike.current - spike.average) / Math.max(spike.average, 1)) * 100)}% above the 30-day hourly average of ${spike.average}.\n\nThis may indicate a new issue or degraded service.`,
          sourceIntegrations: ["anomaly"],
        });
        anomalies++;
      } catch {
        // Dedup might catch this — non-blocking
      }
    }
  } catch (err) {
    console.error("[anomaly] Aggregation failed:", err);
  }

  console.log(`[anomaly] aggregated=${aggregated} anomalies=${anomalies}`);
  return { aggregated, anomalies };
}
