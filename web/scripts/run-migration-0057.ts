/**
 * One-off migration runner for 0057_var_foundation.sql.
 *
 * VAR Q1 foundation:
 *   - alerts.session_id (text, nullable, indexed)
 *   - substrate_recordings.session_id (text, nullable, indexed)
 *   - product_metrics table (telemetry append-only)
 *   - whatif_replays table (Substrate replay cache)
 *
 * Idempotent (IF NOT EXISTS / IF NOT EXISTS), safe to re-run.
 *
 * Usage: cd web && npx tsx scripts/run-migration-0057.ts
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

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

  // ── 1. session_id on alerts ────────────────────────────────────────────────
  console.log("Adding alerts.session_id column ...");
  await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS session_id text`;

  console.log("Creating alerts_session_id_idx ...");
  await sql`
    CREATE INDEX IF NOT EXISTS alerts_session_id_idx
      ON alerts (session_id)
      WHERE session_id IS NOT NULL
  `;

  // ── 2. session_id on substrate_recordings ─────────────────────────────────
  console.log("Adding substrate_recordings.session_id column ...");
  await sql`ALTER TABLE substrate_recordings ADD COLUMN IF NOT EXISTS session_id text`;

  console.log("Creating substrate_recordings_session_id_idx ...");
  await sql`
    CREATE INDEX IF NOT EXISTS substrate_recordings_session_id_idx
      ON substrate_recordings (session_id)
      WHERE session_id IS NOT NULL
  `;

  // ── 3. product_metrics table ──────────────────────────────────────────────
  console.log("Creating product_metrics table ...");
  await sql`
    CREATE TABLE IF NOT EXISTS product_metrics (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
      event           text NOT NULL,
      value_numeric   double precision,
      value_text      text,
      metadata        jsonb,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `;

  console.log("Creating product_metrics_event_created_idx ...");
  await sql`
    CREATE INDEX IF NOT EXISTS product_metrics_event_created_idx
      ON product_metrics (event, created_at DESC)
  `;

  console.log("Creating product_metrics_org_created_idx ...");
  await sql`
    CREATE INDEX IF NOT EXISTS product_metrics_org_created_idx
      ON product_metrics (organization_id, created_at DESC)
      WHERE organization_id IS NOT NULL
  `;

  // ── 4. whatif_replays table ───────────────────────────────────────────────
  console.log("Creating whatif_replays table ...");
  await sql`
    CREATE TABLE IF NOT EXISTS whatif_replays (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id       text NOT NULL,
      fix_commit_sha   text NOT NULL,
      fix_id           uuid,
      result           jsonb NOT NULL,
      status           text NOT NULL DEFAULT 'ready',
      computed_at      timestamptz NOT NULL DEFAULT now(),
      last_accessed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT whatif_replays_unique_per_fix UNIQUE (session_id, fix_commit_sha)
    )
  `;

  console.log("Creating whatif_replays_session_idx ...");
  await sql`
    CREATE INDEX IF NOT EXISTS whatif_replays_session_idx
      ON whatif_replays (session_id)
  `;

  console.log("Creating whatif_replays_fix_idx ...");
  await sql`
    CREATE INDEX IF NOT EXISTS whatif_replays_fix_idx
      ON whatif_replays (fix_id)
      WHERE fix_id IS NOT NULL
  `;

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log("\nVerifying schema ...");

  const alertsCol = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'alerts' AND column_name = 'session_id'
  `;
  if (alertsCol.length !== 1) {
    console.error("alerts.session_id NOT FOUND");
    process.exit(1);
  }
  console.log("✓ alerts.session_id exists");

  const subCol = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'substrate_recordings' AND column_name = 'session_id'
  `;
  if (subCol.length !== 1) {
    console.error("substrate_recordings.session_id NOT FOUND");
    process.exit(1);
  }
  console.log("✓ substrate_recordings.session_id exists");

  const pm = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'product_metrics'
    ORDER BY ordinal_position
  `;
  if (pm.length === 0) {
    console.error("product_metrics table NOT FOUND");
    process.exit(1);
  }
  console.log(`✓ product_metrics: ${pm.map((r) => r.column_name).join(", ")}`);

  const wr = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'whatif_replays'
    ORDER BY ordinal_position
  `;
  if (wr.length === 0) {
    console.error("whatif_replays table NOT FOUND");
    process.exit(1);
  }
  console.log(`✓ whatif_replays: ${wr.map((r) => r.column_name).join(", ")}`);

  console.log("\nMigration 0057 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
