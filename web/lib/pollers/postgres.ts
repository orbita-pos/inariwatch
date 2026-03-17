import type { NewAlert } from "@/lib/db";
import { Client } from "pg";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PostgresConfig {
  connectionString: string;
  name: string;
}

export interface PostgresAlertConfig {
  connection_failed?: { enabled: boolean };
  high_connections?:  { enabled: boolean; thresholdPercent: number };
  long_queries?:      { enabled: boolean; thresholdSec: number };
}

// ── Poller ───────────────────────────────────────────────────────────────────

export async function pollPostgres(
  config: PostgresConfig,
  alertConfig: PostgresAlertConfig = {}
): Promise<Omit<NewAlert, "projectId">[]> {
  const results: Omit<NewAlert, "projectId">[] = [];

  const checkConnection  = alertConfig.connection_failed?.enabled !== false;
  const checkConnections = alertConfig.high_connections?.enabled  !== false;
  const checkLongQueries = alertConfig.long_queries?.enabled      !== false;

  const connectionThreshold = alertConfig.high_connections?.thresholdPercent ?? 80;
  const longQueryThreshold  = alertConfig.long_queries?.thresholdSec ?? 30;

  const dbName = config.name || "PostgreSQL";

  const client = new Client({
    connectionString: config.connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });

  try {
    await client.connect();
  } catch (err) {
    if (checkConnection) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({
        severity: "critical",
        title: `[Postgres] Connection failed — ${dbName}`,
        body: `Could not connect to the PostgreSQL database: ${reason}`,
        sourceIntegrations: ["postgres"],
        isRead: false,
        isResolved: false,
      });
    }
    return results;
  }

  try {
    // ── High connection count ──────────────────────────────────────────────────
    if (checkConnections) {
      try {
        const connResult = await client.query(`
          SELECT
            (SELECT count(*)::int FROM pg_stat_activity) AS active,
            (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
        `);
        const row = connResult.rows[0];
        if (row) {
          const active = row.active as number;
          const max    = row.max as number;
          const pct    = max > 0 ? Math.round((active / max) * 100) : 0;

          if (pct >= connectionThreshold) {
            results.push({
              severity: pct >= 95 ? "critical" : "warning",
              title: `[Postgres] High connections — ${dbName} (${pct}%)`,
              body: `${active} of ${max} connections in use (${pct}%). Threshold: ${connectionThreshold}%.`,
              sourceIntegrations: ["postgres"],
              isRead: false,
              isResolved: false,
            });
          }
        }
      } catch {
        // Skip if we can't query connection stats (permissions)
      }
    }

    // ── Long-running queries ───────────────────────────────────────────────────
    if (checkLongQueries) {
      try {
        const longResult = await client.query(`
          SELECT
            pid,
            EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec,
            LEFT(query, 200) AS query
          FROM pg_stat_activity
          WHERE state = 'active'
            AND query NOT ILIKE '%pg_stat_activity%'
            AND now() - query_start > interval '${longQueryThreshold} seconds'
          ORDER BY query_start ASC
          LIMIT 10
        `);

        if (longResult.rows.length > 0) {
          const queries = longResult.rows
            .slice(0, 5)
            .map((r) => `PID ${r.pid}: ${r.duration_sec}s — ${(r.query as string).slice(0, 80)}…`)
            .join("\n");

          results.push({
            severity: "warning",
            title: `[Postgres] ${longResult.rows.length} long-running query(s) — ${dbName}`,
            body: `Queries running longer than ${longQueryThreshold}s:\n${queries}`,
            sourceIntegrations: ["postgres"],
            isRead: false,
            isResolved: false,
          });
        }
      } catch {
        // Skip if we can't query long-running queries (permissions)
      }
    }

    // ── Database size ──────────────────────────────────────────────────────────
    try {
      const sizeResult = await client.query(`
        SELECT pg_database_size(current_database()) AS size_bytes
      `);
      // We store the size info but don't alert on it for now —
      // this data can be used for trend detection in future versions.
      // The size is available if needed for correlation.
    } catch {
      // Skip if we can't get database size
    }
  } finally {
    await client.end().catch(() => {});
  }

  return results;
}
