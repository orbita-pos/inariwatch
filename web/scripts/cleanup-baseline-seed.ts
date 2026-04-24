/**
 * Cleanup baseline seed fixtures.
 *
 * Removes alerts (and cascading remediation_sessions, ai_usage_logs, etc.)
 * labeled with `correlationData.seed = true`. Use this after a baseline
 * seed run so the production tables stay clean.
 *
 * Usage:
 *   npx tsx scripts/cleanup-baseline-seed.ts                      # all seeded alerts
 *   npx tsx scripts/cleanup-baseline-seed.ts --baseline-run <ts>  # only one run
 *   npx tsx scripts/cleanup-baseline-seed.ts --dry-run            # preview only
 */

import { config } from "dotenv";
import path from "path";

config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const neonSql = neon(process.env.DATABASE_URL!);
const db = drizzle(neonSql, { schema });

interface Args {
  baselineRun?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const runIdx = args.indexOf("--baseline-run");
  return {
    baselineRun: runIdx >= 0 ? args[runIdx + 1] : undefined,
    dryRun: args.includes("--dry-run"),
  };
}

async function main() {
  const args = parseArgs();

  console.log(`🧹 InariWatch baseline seed cleanup`);
  console.log(`   mode: ${args.dryRun ? "DRY RUN (no deletes)" : "LIVE"}`);
  console.log(`   scope: ${args.baselineRun ? `baselineRun = "${args.baselineRun}"` : "all seeded alerts"}`);
  console.log();

  // Count first
  const countWhere = args.baselineRun
    ? sql`correlation_data->>'seed' = 'true' AND correlation_data->>'baselineRun' = ${args.baselineRun}`
    : sql`correlation_data->>'seed' = 'true'`;

  const countRows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM alerts WHERE ${countWhere}
  `);
  const list = (countRows as unknown as { rows: { count: string }[] }).rows ?? countRows;
  const count = parseInt((list as { count: string }[])[0]?.count ?? "0", 10);

  console.log(`Found ${count} matching seeded alerts.`);

  if (count === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  if (args.dryRun) {
    // Show preview
    const previewRows = await db.execute<{
      id: string;
      title: string;
      created_at: string;
    }>(sql`
      SELECT id, title, created_at::text
      FROM alerts
      WHERE ${countWhere}
      ORDER BY created_at DESC
      LIMIT 10
    `);
    const plist = (previewRows as unknown as { rows: { id: string; title: string; created_at: string }[] }).rows ?? previewRows;
    console.log(`\nFirst 10 matches:`);
    (plist as { id: string; title: string; created_at: string }[]).forEach((r) => {
      console.log(`  ${r.id.slice(0, 8)}…  ${r.title.slice(0, 70)}`);
    });
    console.log(`\nDry run — no deletes performed.`);
    return;
  }

  // Delete cascades through to remediation_sessions, ai_usage_logs, etc.
  // (schema.ts has ON DELETE CASCADE / SET NULL on the FK columns).
  console.log(`\nDeleting ${count} alerts (cascade will clean up related rows)...`);

  const result = await db.execute(sql`
    DELETE FROM alerts WHERE ${countWhere}
  `);

  console.log(`✅ Deleted ${count} alerts. Related remediation_sessions + ai_usage_logs rows cleaned up via cascade / SET NULL.`);
  console.log(`\nVerify at /admin/ai — seeded sessions should be gone from the dashboard.`);

  // Drizzle type bookkeeping
  void result;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
