import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL! });
  await client.connect();

  const migrationPath = join(process.cwd(), "lib", "db", "migrations", "0042_webhook_dedup.sql");
  const migrationSql = readFileSync(migrationPath, "utf-8");

  const cleaned = migrationSql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const statements = cleaned
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Running ${statements.length} statements from 0042`);
  for (const [i, stmt] of statements.entries()) {
    const preview = stmt.split("\n")[0].slice(0, 70);
    console.log(`  [${i + 1}/${statements.length}] ${preview}...`);
    try {
      await client.query(stmt);
      console.log("    OK");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        console.log("    (already applied)");
      } else {
        console.error("    FAIL:", msg);
        await client.end();
        throw err;
      }
    }
  }

  await client.end();
  console.log("\nMigration 0042 complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
