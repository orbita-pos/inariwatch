#!/usr/bin/env node
/**
 * Applies V1 migrations 0089–0092 directly via pg, bypassing drizzle-kit.
 *
 * Use case: production DB drift made `drizzle-kit push` propose
 * destructive changes on existing tables. This script ONLY runs the
 * 4 new SQL files for S1+S2+S3+S5; it never touches existing schema.
 *
 * Run from web/:
 *   node scripts/apply-v1-migrations.mjs
 *
 * Reads DATABASE_URL from env (set externally by sops decrypt).
 * Each migration runs in its own transaction; on error, ROLLBACK and
 * report. On expected "already exists" errors (42710, 42P07), it
 * skips and continues — safe to re-run.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "lib", "db", "migrations");

const FILES = [
  "0089_project_tokens.sql",
  "0090_device_tokens.sql",
  "0091_project_wizard_state.sql",
  "0092_conversations.sql",
];

// Postgres error codes that mean "this object already exists" — safe to ignore
// when re-running migrations (idempotent path).
const ALREADY_EXISTS_CODES = new Set([
  "42710", // duplicate_object — type/enum already exists
  "42P07", // duplicate_table
  "42701", // duplicate_column
  "42P06", // duplicate_schema
]);

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL not set in env. Run sops decrypt first.");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  console.log("Connected to DB.\n");

  for (const file of FILES) {
    const path = join(MIGRATIONS_DIR, file);
    const sql = readFileSync(path, "utf8");
    console.log(`── ${file} ──`);

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      console.log(`  ✓ applied\n`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code && ALREADY_EXISTS_CODES.has(err.code)) {
        console.log(`  ⊘ skip — objects already exist (${err.code}: ${err.message.split("\n")[0]})\n`);
      } else {
        console.error(`  ✗ FAILED: ${err.code ?? "?"}: ${err.message}`);
        console.error(`    Aborting. Other migrations not applied.\n`);
        process.exit(2);
      }
    }
  }

  // Verify the 4 new tables exist.
  console.log("── verification ──");
  const expected = ["project_tokens", "device_tokens", "conversations", "conversation_messages"];
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])",
    [expected],
  );
  const present = new Set(rows.map((r) => r.tablename));
  for (const t of expected) {
    console.log(`  ${present.has(t) ? "✓" : "✗"} ${t}`);
  }

  // Check projects table has new columns from 0091.
  const { rows: cols } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='projects' AND column_name = ANY($1::text[])",
    [["state", "framework", "host"]],
  );
  const colSet = new Set(cols.map((r) => r.column_name));
  for (const c of ["state", "framework", "host"]) {
    console.log(`  ${colSet.has(c) ? "✓" : "✗"} projects.${c}`);
  }

  await client.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  client.end().catch(() => {});
  process.exit(1);
});
