/**
 * Run migration 0040_ai_usage_logs.sql against the production DB.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0040.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: process.env.DATABASE_URL!,
  });
  await client.connect();

  const migrationPath = join(
    process.cwd(),
    "lib",
    "db",
    "migrations",
    "0040_ai_usage_logs.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // Strip comments and split on semicolons at end of line.
  const cleaned = migrationSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = cleaned
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Running ${statements.length} statements from 0040_ai_usage_logs.sql`);

  for (const [i, stmt] of statements.entries()) {
    const preview = stmt.split("\n")[0].slice(0, 70);
    console.log(`  [${i + 1}/${statements.length}] ${preview}...`);
    try {
      await client.query(stmt);
      console.log("    OK");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists") || msg.includes("duplicate column")) {
        console.log("    (already applied, skipping)");
      } else {
        console.error("    FAIL:", msg);
        await client.end();
        throw err;
      }
    }
  }

  await client.end();
  console.log("\nMigration 0040 complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
