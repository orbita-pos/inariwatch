/**
 * Run migration 0072_tier_router_labels.sql.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0072.ts
 *
 * Idempotent — table/index/constraint creation use IF NOT EXISTS / DO blocks.
 * Rollback: cd web && npx tsx scripts/run-migration-0072.ts --rollback
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const rollback = process.argv.includes("--rollback");
  const file = rollback
    ? "0072_tier_router_labels.rollback.sql"
    : "0072_tier_router_labels.sql";

  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const migrationPath = join(process.cwd(), "lib", "db", "migrations", file);
  const sql = readFileSync(migrationPath, "utf-8");

  // DO $$ ... END $$ blocks contain inner semicolons, so naive splitting would
  // shred them. Run the file as one statement — pg's simple query protocol
  // accepts multi-statement text.
  console.log(`Applying ${file}...`);
  await client.query(sql);

  if (!rollback) {
    const cols = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'tier_router_labels'
      ORDER BY ordinal_position
    `);
    if (cols.rows.length === 0) {
      console.error("tier_router_labels was NOT created!");
      process.exit(1);
    }
    console.log(`tier_router_labels columns:`);
    for (const c of cols.rows) {
      console.log(`  ✓ ${c.column_name} (${c.data_type}, nullable=${c.is_nullable})`);
    }

    const idx = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'tier_router_labels'
      ORDER BY indexname
    `);
    console.log(`\nIndexes:`);
    for (const i of idx.rows) console.log(`  ✓ ${i.indexname}`);
  }

  await client.end();
  console.log(`\nMigration ${rollback ? "rolled back" : "applied"}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
