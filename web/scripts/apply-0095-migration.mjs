#!/usr/bin/env node
/**
 * Applies migration 0095_test_generation_sessions.sql directly via pg.
 *
 * Creates the test_generation_sessions table used by Inari Guard
 * (the `/test <path>` flow). Mirror of remediation_sessions with
 * test-specific fields (plan, gates, framework_detected, etc).
 *
 * Run from web/:
 *   node scripts/apply-0095-migration.mjs
 *
 * Reads DATABASE_URL from env or .env.local. Idempotent — checks for
 * the table BEFORE running and skips when present.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

try {
  const { config } = await import("dotenv");
  config({ path: ".env.local" });
} catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "lib", "db", "migrations");

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL not set. Load env first (sops decrypt or .env.local).");
  process.exit(1);
}

const sql = readFileSync(join(MIGRATIONS_DIR, "0095_test_generation_sessions.sql"), "utf8");

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("sslmode=require") || process.env.DATABASE_URL.includes("neon.tech")
    ? { rejectUnauthorized: false }
    : undefined,
});

try {
  await client.connect();
  console.log("Connected to DB");

  // Idempotency — bail early if the table is already there
  const existing = await client.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'test_generation_sessions'
  `);
  if (existing.rowCount && existing.rowCount > 0) {
    console.log("Table test_generation_sessions already exists — migration is a no-op.");
    process.exit(0);
  }

  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  console.log("✓ Migration 0095 applied — test_generation_sessions table created");

  // Sanity check — index count
  const indices = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'test_generation_sessions'
  `);
  console.log(`✓ ${indices.rowCount} indices created:`);
  indices.rows.forEach((r) => console.log(`    - ${r.indexname}`));
} catch (err) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error("Migration failed:", err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}
