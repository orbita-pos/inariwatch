/**
 * check-db-truth.ts — confirm which DB we're hitting and what's actually in it.
 *
 * Run:  cd web && npx tsx scripts/check-db-truth.ts
 *
 * Read-only. Answers: "is this prod, dev, or empty?"
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { sql } from "drizzle-orm";

async function main() {
  const { db } = await import("../lib/db");

  console.log("\n=== DB Truth Check ===");
  console.log(`DB: ${process.env.DATABASE_URL?.split("@")[1]?.split("/")[0] ?? "(unknown)"}\n`);

  const queries: Array<[string, any]> = [
    ["users",                  sql`SELECT COUNT(*)::int AS n FROM users`],
    ["workspaces",             sql`SELECT COUNT(*)::int AS n FROM workspaces`],
    ["projects",               sql`SELECT COUNT(*)::int AS n FROM projects`],
    ["alerts (total)",         sql`SELECT COUNT(*)::int AS n FROM alerts`],
    ["alerts (last 7d)",       sql`SELECT COUNT(*)::int AS n FROM alerts WHERE created_at > NOW() - INTERVAL '7 days'`],
    ["alerts (last 30d)",      sql`SELECT COUNT(*)::int AS n FROM alerts WHERE created_at > NOW() - INTERVAL '30 days'`],
    ["remediation_sessions (total)", sql`SELECT COUNT(*)::int AS n FROM remediation_sessions`],
    ["remediation_sessions (30d)",   sql`SELECT COUNT(*)::int AS n FROM remediation_sessions WHERE created_at > NOW() - INTERVAL '30 days'`],
    ["ai_usage_logs (total)",  sql`SELECT COUNT(*)::int AS n FROM ai_usage_logs`],
    ["ai_usage_logs (last 7d)", sql`SELECT COUNT(*)::int AS n FROM ai_usage_logs WHERE created_at > NOW() - INTERVAL '7 days'`],
    ["pattern_memory",         sql`SELECT COUNT(*)::int AS n FROM pattern_memory`],
  ];

  for (const [label, q] of queries) {
    try {
      const r = (await db.execute(q)) as unknown as Array<{ n: number }>;
      console.log(`  ${label.padEnd(32)} ${r[0]?.n ?? 0}`);
    } catch (e: any) {
      console.log(`  ${label.padEnd(32)} ERROR: ${e?.message?.slice(0, 60) ?? "—"}`);
    }
  }

  console.log("\n── Most recent activity ──");
  try {
    const r = (await db.execute(sql`
      SELECT
        MAX(created_at)::text AS latest_alert,
        (SELECT MAX(created_at)::text FROM remediation_sessions) AS latest_remediation,
        (SELECT MAX(created_at)::text FROM ai_usage_logs) AS latest_ai_call
      FROM alerts
    `)) as unknown as Array<{ latest_alert: string | null; latest_remediation: string | null; latest_ai_call: string | null }>;
    console.log(`  Latest alert:        ${r[0]?.latest_alert ?? "(none)"}`);
    console.log(`  Latest remediation:  ${r[0]?.latest_remediation ?? "(none)"}`);
    console.log(`  Latest AI call:      ${r[0]?.latest_ai_call ?? "(none)"}`);
  } catch (e: any) {
    console.log(`  ERROR: ${e?.message ?? "—"}`);
  }

  console.log("\n── Migrations applied ──");
  try {
    const r = (await db.execute(sql`
      SELECT id, hash, created_at::text
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 10
    `)) as unknown as Array<{ id: number; hash: string; created_at: string }>;
    if (r.length === 0) console.log("  (none — drizzle migrations table empty)");
    for (const row of r) console.log(`  #${row.id}  ${row.created_at}  ${row.hash.slice(0, 50)}`);
  } catch (e: any) {
    console.log(`  ERROR: ${e?.message?.slice(0, 80) ?? "—"}`);
    console.log(`  → drizzle migrations table not found. Try: SELECT * FROM "__drizzle_migrations"`);
    try {
      const r = (await db.execute(sql`SELECT id, hash, created_at::text FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 10`)) as unknown as Array<{ id: number; hash: string; created_at: string }>;
      for (const row of r) console.log(`  #${row.id}  ${row.created_at}  ${row.hash.slice(0, 50)}`);
    } catch (e2: any) {
      console.log(`  Also failed: ${e2?.message?.slice(0, 80) ?? "—"}`);
    }
  }

  process.exit(0);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
