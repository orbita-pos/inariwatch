/**
 * Code Intelligence v2 dogfood cleanup.
 *
 * Removes alerts (and their cascading remediation_sessions / ai_usage_logs)
 * inserted by `seed-codeintel-dogfood.ts`.
 *
 * Usage:
 *   npx tsx scripts/cleanup-codeintel-dogfood.ts                         # delete ALL dogfood seed
 *   npx tsx scripts/cleanup-codeintel-dogfood.ts --run 2026-05-02T...   # delete one run
 *   npx tsx scripts/cleanup-codeintel-dogfood.ts --dry-run               # show count only
 *
 * Safety: only deletes rows where correlation_data->>'seed' = 'codeintel-dogfood'.
 * Cannot accidentally remove real production alerts.
 */

import { config } from "dotenv";
import path from "path";

config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql as drizzleSql } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

interface Args {
  run?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") out.run = argv[++i];
    else if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(`usage: cleanup-codeintel-dogfood [--run <iso>] [--dry-run]`);
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const runFilter = args.run
    ? drizzleSql`AND correlation_data->>'dogfoodRun' = ${args.run}`
    : drizzleSql``;

  // Count first
  const countRows = await db.execute<{ count: number }>(drizzleSql`
    SELECT count(*)::int AS count
      FROM alerts
     WHERE correlation_data->>'seed' = 'codeintel-dogfood'
       ${runFilter}
  `);
  const total = (Array.isArray(countRows) ? countRows[0] : countRows.rows[0])?.count ?? 0;

  if (args.dryRun) {
    console.log(`Would delete ${total} alerts (and cascading remediation_sessions / ai_usage_logs).`);
    if (args.run) console.log(`Filtered by run: ${args.run}`);
    return;
  }

  if (total === 0) {
    console.log("Nothing to delete.");
    return;
  }

  const result = await db.execute(drizzleSql`
    DELETE FROM alerts
     WHERE correlation_data->>'seed' = 'codeintel-dogfood'
       ${runFilter}
  `);

  console.log(`Deleted ${total} dogfood alerts.`);
  console.log(`(remediation_sessions and ai_usage_logs cascade automatically.)`);
  void result;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
