#!/usr/bin/env node
/**
 * One-off migration applier for 0096_visual_reports.sql.
 *
 * Drizzle-kit's journal got out of sync (later migrations re-declare enums
 * that already exist in the DB), so `npm run db:migrate` won't apply just
 * the new tail. This script reads the 0096 file and runs it directly,
 * idempotently (skip if visual_reports table already exists).
 *
 * Run from `web/`:
 *   node scripts/apply-migration-0096.mjs
 *
 * Uses DATABASE_URL from `.env.local`. Safe to run twice — second run is
 * a no-op once visual_reports exists.
 */

import { config } from "dotenv";
import { readFileSync } from "fs";
import { Client } from "pg";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

config({ path: resolve(__dirname, "..", ".env.local") });

const migrationPath = resolve(__dirname, "..", "lib", "db", "migrations", "0096_visual_reports.sql");
const sql = readFileSync(migrationPath, "utf-8");

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const check = await client.query(
    "SELECT to_regclass('public.visual_reports') AS exists",
  );
  if (check.rows[0].exists) {
    console.log("✓ visual_reports table already exists — skipping migration");
  } else {
    await client.query(sql);
    console.log("✓ migration 0096 applied successfully");
  }

  // Verify the columns landed.
  const cols = await client.query(`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'visual_reports'
  ORDER BY ordinal_position
  `);
  console.log(`✓ visual_reports has ${cols.rows.length} columns:`);
  for (const r of cols.rows) {
    console.log(`    ${r.column_name.padEnd(20)} :: ${r.data_type}`);
  }

  // Verify indexes.
  const idx = await client.query(`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'visual_reports'
  ORDER BY indexname
  `);
  console.log(`✓ visual_reports has ${idx.rows.length} indexes:`);
  for (const r of idx.rows) console.log(`    ${r.indexname}`);
} finally {
  await client.end();
}
