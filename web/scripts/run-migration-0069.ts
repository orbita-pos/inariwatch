/**
 * Run migration 0069_telemetry_foundation.sql.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0069.ts
 *
 * Idempotent — existing columns/indexes/constraints are skipped on replay.
 * Rollback: cd web && npx tsx scripts/run-migration-0069.ts --rollback
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const rollback = process.argv.includes("--rollback");
  const file = rollback
    ? "0069_telemetry_foundation.rollback.sql"
    : "0069_telemetry_foundation.sql";

  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const migrationPath = join(process.cwd(), "lib", "db", "migrations", file);
  const sql = readFileSync(migrationPath, "utf-8");

  // DO $$ ... END $$ blocks contain inner semicolons, so splitting on `;` at
  // end-of-line would shred them. Run the file as one statement — pg's simple
  // query protocol accepts multi-statement text.
  console.log(`Applying ${file}...`);
  await client.query(sql);

  await client.end();
  console.log(`Migration ${rollback ? "rolled back" : "applied"}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
