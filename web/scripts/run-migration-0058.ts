/**
 * One-off migration runner for 0058_fleet_verification.sql.
 *
 * Creates the fleet_verification_runs table + indexes used by VAR
 * Gate 12 ("What-If Across Fleet"). Idempotent (CREATE ... IF NOT
 * EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx --env-file=.env.local scripts/run-migration-0058.ts
 */

import { readFileSync } from "fs";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  const raw = readFileSync("lib/db/migrations/0058_fleet_verification.sql", "utf-8");
  const statements = splitStatements(raw);

  console.log(`Applying ${statements.length} statements ...`);
  for (const stmt of statements) {
    const preview = stmt.slice(0, 80).replace(/\s+/g, " ");
    console.log(`  ▸ ${preview}...`);
    await db.execute(sql.raw(stmt));
  }

  console.log("Done.");
}

function splitStatements(raw: string): string[] {
  const stripped = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
