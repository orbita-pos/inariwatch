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
            usename,
            application_name,
            client_addr,
            wait_event_type,
            wait_event,
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
            .map((r) => {
              const who = [r.usename, r.application_name].filter(Boolean).join(" / ");
              const wait = r.wait_event ? ` [waiting: ${r.wait_event_type}/${r.wait_event}]` : "";
              const from = r.client_addr ? ` from ${r.client_addr}` : "";
              return `PID ${r.pid} (${who}${from}) ${r.duration_sec}s${wait}\n  ${(r.query as string).slice(0, 120)}`;
            })
            .join("\n");

          results.push({
            severity: "warning",
            title: `[Postgres] ${longResult.rows.length} long-running query(s) — ${dbName}`,
            body: `Queries running longer than ${longQueryThreshold}s:\n\n${queries}`,
            sourceIntegrations: ["postgres"],
            isRead: false,
            isResolved: false,
          });
        }
      } catch {
        // Skip if we can't query long-running queries (permissions)
      }
    }

    // ── Blocking queries (lock waits) ──────────────────────────────────────────
    try {
      const blockResult = await client.query(`
        SELECT
          blocked.pid                     AS blocked_pid,
          blocked.usename                 AS blocked_user,
          blocked.application_name        AS blocked_app,
          EXTRACT(EPOCH FROM (now() - blocked.query_start))::int AS blocked_sec,
          LEFT(blocked.query, 150)        AS blocked_query,
          blocking.pid                    AS blocking_pid,
          blocking.usename                AS blocking_user,
          EXTRACT(EPOCH FROM (now() - blocking.query_start))::int AS blocking_sec,
          LEFT(blocking.query, 150)       AS blocking_query
        FROM pg_stat_activity AS blocked
        JOIN pg_stat_activity AS blocking
          ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
        WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
        LIMIT 5
      `);

      if (blockResult.rows.length > 0) {
        const blocks = blockResult.rows
          .map((r) =>
            `PID ${r.blocked_pid} (${r.blocked_user}/${r.blocked_app}) blocked for ${r.blocked_sec}s\n` +
            `  Query: ${r.blocked_query}\n` +
            `  Blocked by PID ${r.blocking_pid} (${r.blocking_user}, running ${r.blocking_sec}s)\n` +
            `  Blocking query: ${r.blocking_query}`
          )
          .join("\n\n");

        results.push({
          severity: "critical",
          title: `[Postgres] ${blockResult.rows.length} blocked query(s) — ${dbName}`,
          body: `Queries blocked by lock contention:\n\n${blocks}`,
          sourceIntegrations: ["postgres"],
          isRead: false,
          isResolved: false,
        });
      }
    } catch {
      // Skip if pg_blocking_pids not available (requires PG 9.6+)
    }

    // ── Idle-in-transaction connections ────────────────────────────────────────
    try {
      const idleTxResult = await client.query(`
        SELECT
          pid,
          usename,
          application_name,
          client_addr,
          EXTRACT(EPOCH FROM (now() - state_change))::int AS idle_tx_sec
        FROM pg_stat_activity
        WHERE state = 'idle in transaction'
          AND now() - state_change > interval '60 seconds'
        ORDER BY state_change ASC
        LIMIT 10
      `);

      if (idleTxResult.rows.length > 0) {
        const idlers = idleTxResult.rows
          .slice(0, 5)
          .map((r) => {
            const who = [r.usename, r.application_name].filter(Boolean).join(" / ");
            const from = r.client_addr ? ` from ${r.client_addr}` : "";
            return `PID ${r.pid} (${who}${from}) idle in transaction for ${r.idle_tx_sec}s`;
          })
          .join("\n");

        results.push({
          severity: "warning",
          title: `[Postgres] ${idleTxResult.rows.length} idle-in-transaction connection(s) — ${dbName}`,
          body: `Connections holding open transactions (>60s):\n\n${idlers}\n\nIdle transactions hold locks and can cause connection exhaustion.`,
          sourceIntegrations: ["postgres"],
          isRead: false,
          isResolved: false,
        });
      }
    } catch {
      // Skip if permissions insufficient
    }
  } finally {
    await client.end().catch(() => {});
  }

  return results;
}
