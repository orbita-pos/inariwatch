/**
 * One-off migration runner for 0064_eap_receipt_id.sql.
 *
 * Adds remediation_sessions.eap_receipt_id + partial index.
 * Idempotent (ADD COLUMN IF NOT EXISTS).
 *
 * Usage: cd web && npx tsx scripts/run-migration-0064.ts
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";
import { resolve as resolvePath } from "node:path";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!match) {
    console.error("DATABASE_URL not found in .env.local");
    process.exit(1);
  }
  const dbUrl = match[1];
  const host = dbUrl.match(/@([^/]+)/)?.[1] ?? "unknown";
  console.log(`Connecting to ${host} ...`);
  const sql = neon(dbUrl);

  const migrationPath = resolvePath(
    process.cwd(),
    "lib/db/migrations/0064_eap_receipt_id.sql",
  );
  const src = readFileSync(migrationPath, "utf-8");
  const statements = splitSqlStatements(src);
  console.log(`Migration has ${statements.length} statement(s).`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (!stmt) continue;
    const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
    console.log(`[${i + 1}/${statements.length}] ${preview} ...`);
    await sql(stmt);
  }

  console.log("\nVerifying column exists ...");
  const rows = (await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'remediation_sessions'
      AND column_name = 'eap_receipt_id'
  `) as Array<{ column_name: string }>;
  if (rows.length === 1) {
    console.log(`  ✓ remediation_sessions.eap_receipt_id`);
  } else {
    console.error("Column missing after migration!");
    process.exit(1);
  }

  console.log("\nMigration 0064 applied successfully.");
}

function splitSqlStatements(src: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "-" && next === "-") {
      buf += c;
      i++;
      while (i < src.length && src[i] !== "\n") { buf += src[i]; i++; }
      continue;
    }
    if (c === "'") {
      buf += c;
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { buf += "''"; i += 2; continue; }
        buf += src[i];
        if (src[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
