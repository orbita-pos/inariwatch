/**
 * Seed a synthetic FullTrace session for visual validation of Sesión 2.
 *
 * Inserts (idempotent — fixed UUIDs, ON CONFLICT DO NOTHING):
 *   1. A replay_session with blockCount=0 (rrweb video skipped — we're
 *      validating the new Backend + AI panels, not playback)
 *   2. Two substrate_recordings carrying realistic HTTP / DB / Exception
 *      events that tell a "checkout failed at Stripe" story
 *   3. One alert tagged with the same session_id, with a written aiReasoning
 *   4. One remediation_session with 4 steps (diagnose → fix → push → merge)
 *      that completed successfully and merged a PR
 *
 * Run: cd web && npx tsx scripts/seed-fulltrace-demo.ts [orgEmail]
 *
 * If orgEmail is omitted, we look up the user from USER_EMAIL env var.
 * The script prints the URL to visit at the end. Re-running is safe.
 *
 * Cleanup: pass --clean to delete the seeded rows.
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

// Stable IDs — re-run = upsert (or skip), no orphan duplicates ever.
const SESSION_ID = "fulltrace-demo-sess-001";
const REPLAY_SESSION_UUID = "11111111-1111-4111-8111-111111111111";
const REC_1_UUID = "22222222-2222-4222-8222-222222222222";
const REC_2_UUID = "22222222-2222-4222-8222-222222222223";
const REC_1_ID = "fulltrace-demo-rec-001";
const REC_2_ID = "fulltrace-demo-rec-002";
const ALERT_UUID = "33333333-3333-4333-8333-333333333333";
const REM_UUID = "44444444-4444-4444-8444-444444444444";

async function main() {
  const args = process.argv.slice(2);
  const clean = args.includes("--clean");
  const userEmailArg = args.find((a) => !a.startsWith("--"));

  const env = readFileSync(".env.local", "utf-8");
  const dbUrlMatch = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!dbUrlMatch) {
    console.error("DATABASE_URL not found in .env.local");
    process.exit(1);
  }
  const sql = neon(dbUrlMatch[1]);

  // ── Find target user / org / project ─────────────────────────────────────
  const targetEmail = userEmailArg ?? process.env.USER_EMAIL ?? "demo@inariwatch.com";
  console.log(`Target user email: ${targetEmail}`);

  const userRows = await sql`
    SELECT id FROM users WHERE email = ${targetEmail} LIMIT 1
  `;
  if (userRows.length === 0) {
    console.error(`User ${targetEmail} not found. Pass an existing email as the first arg, or set USER_EMAIL.`);
    process.exit(1);
  }
  const userId = userRows[0].id as string;

  const orgRows = await sql`
    SELECT o.id FROM organizations o
    LEFT JOIN organization_members om ON om.organization_id = o.id
    WHERE o.owner_id = ${userId} OR om.user_id = ${userId}
    ORDER BY o.created_at ASC
    LIMIT 1
  `;
  if (orgRows.length === 0) {
    console.error("User has no organizations. Create one first via the dashboard.");
    process.exit(1);
  }
  const organizationId = orgRows[0].id as string;

  const projectRows = await sql`
    SELECT id FROM projects
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (projectRows.length === 0) {
    console.error(`Org ${organizationId} has no projects. Create one first.`);
    process.exit(1);
  }
  const projectId = projectRows[0].id as string;

  console.log(`Using org ${organizationId}, project ${projectId}`);

  // ── Cleanup mode ─────────────────────────────────────────────────────────
  if (clean) {
    console.log("\nCleaning up demo rows ...");
    await sql`DELETE FROM remediation_sessions WHERE id = ${REM_UUID}`;
    await sql`DELETE FROM alerts WHERE id = ${ALERT_UUID}`;
    await sql`DELETE FROM substrate_recordings WHERE recording_id IN (${REC_1_ID}, ${REC_2_ID})`;
    await sql`DELETE FROM replay_sessions WHERE session_id = ${SESSION_ID}`;
    console.log("Done.");
    return;
  }

  // ── 1. replay_session ────────────────────────────────────────────────────
  // blockCount=0 because we're not uploading rrweb blocks — the player will
  // skip rrweb init and the new panels still populate from manifest data.
  const sessionStartedAt = new Date(Date.now() - 5 * 60_000); // 5 min ago
  const sessionEndedAt = new Date(sessionStartedAt.getTime() + 90_000); // 90s session
  const durationMs = 90_000;

  console.log(`\n[1/4] Upserting replay_session ${SESSION_ID} ...`);
  await sql`
    INSERT INTO replay_sessions (
      id, session_id, organization_id, project_id,
      started_at, ended_at, duration_ms,
      r2_prefix, block_count, total_bytes,
      browser, os, country, viewport,
      ai_summary, ai_chapters,
      frustration_score, web_vitals,
      created_at, updated_at
    ) VALUES (
      ${REPLAY_SESSION_UUID}, ${SESSION_ID}, ${organizationId}, ${projectId},
      ${sessionStartedAt.toISOString()}, ${sessionEndedAt.toISOString()}, ${durationMs},
      ${`fulltrace-demo/${SESSION_ID}`}, 0, 0,
      'Chrome 120', 'macOS 14', 'US', ${JSON.stringify({ width: 1440, height: 900, dpr: 2 })}::jsonb,
      'User attempted checkout. Stripe API timed out (30s) → 500 from /api/checkout. AI proposed retry with idempotency key, fix merged automatically.',
      '[]'::jsonb,
      0, '{}'::jsonb,
      now(), now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      duration_ms = EXCLUDED.duration_ms,
      ai_summary = EXCLUDED.ai_summary,
      updated_at = now()
  `;

  // ── 2. alert (created BEFORE recording 2 because that recording's
  //         alert_id FK requires the alert row to exist first) ─────────────
  // Fires at session+82s (when Exception lands in Recording 2).
  console.log(`[2/4] Upserting alert ...`);
  const alertCreatedAt = new Date(sessionStartedAt.getTime() + 82_000);

  await sql`
    INSERT INTO alerts (
      id, project_id, session_id, replay_session_id,
      severity, title, body, source_integrations,
      ai_reasoning, alert_type, fingerprint,
      is_read, is_resolved, created_at
    ) VALUES (
      ${ALERT_UUID}, ${projectId}, ${SESSION_ID}, ${REPLAY_SESSION_UUID},
      'critical', 'Stripe API timeout in /api/checkout',
      'POST /api/checkout returned 500 after Stripe.charges.create() exceeded the 30s timeout.',
      ${"{capture}"}::text[],
      'The checkout endpoint awaits Stripe.charges.create() without an explicit timeout AND without idempotency, so a slow Stripe response cascades into a 500 plus a risk of double-charging on retry. Recommended fix: add an idempotency_key derived from the cart id, set a 10s timeout on the Stripe call, and queue a background reconciliation if Stripe ultimately responds late.',
      'error', 'fulltrace-demo-fp-001',
      false, false, ${alertCreatedAt.toISOString()}
    )
    ON CONFLICT (id) DO UPDATE SET
      ai_reasoning = EXCLUDED.ai_reasoning,
      session_id = EXCLUDED.session_id
  `;

  // ── 3. substrate_recordings ──────────────────────────────────────────────
  // Recording 1: successful product browse (10–25s into session)
  // Recording 2: failed checkout (50–82s into session, ends with Exception)

  console.log(`[3/4] Upserting 2 substrate_recordings ...`);
  const rec1Start = new Date(sessionStartedAt.getTime() + 10_000);
  const rec1Events = buildBrowseEvents(rec1Start.getTime() * 1_000_000);
  const rec2Start = new Date(sessionStartedAt.getTime() + 50_000);
  const rec2Events = buildCheckoutFailureEvents(rec2Start.getTime() * 1_000_000);

  await sql`
    INSERT INTO substrate_recordings (
      id, recording_id, session_id, alert_id, project_id, replay_session_id,
      command, runtime, started_at, ended_at,
      event_count, duration_ms, categories, events,
      created_at, updated_at
    ) VALUES (
      ${REC_1_UUID}, ${REC_1_ID}, ${SESSION_ID}, NULL, ${projectId}, ${REPLAY_SESSION_UUID},
      'next dev', 'node', ${rec1Start.toISOString()}, ${new Date(rec1Start.getTime() + 8_000).toISOString()},
      ${rec1Events.length}, 8000,
      ${JSON.stringify({ http: 2, db: 1 })}::jsonb,
      ${JSON.stringify(rec1Events)}::jsonb,
      now(), now()
    )
    ON CONFLICT (recording_id) DO UPDATE SET
      events = EXCLUDED.events,
      session_id = EXCLUDED.session_id,
      updated_at = now()
  `;

  await sql`
    INSERT INTO substrate_recordings (
      id, recording_id, session_id, alert_id, project_id, replay_session_id,
      command, runtime, started_at, ended_at,
      event_count, duration_ms, categories, events,
      created_at, updated_at
    ) VALUES (
      ${REC_2_UUID}, ${REC_2_ID}, ${SESSION_ID}, ${ALERT_UUID}, ${projectId}, ${REPLAY_SESSION_UUID},
      'next dev', 'node', ${rec2Start.toISOString()}, ${new Date(rec2Start.getTime() + 32_000).toISOString()},
      ${rec2Events.length}, 32000,
      ${JSON.stringify({ http: 3, db: 2, exception: 1 })}::jsonb,
      ${JSON.stringify(rec2Events)}::jsonb,
      now(), now()
    )
    ON CONFLICT (recording_id) DO UPDATE SET
      events = EXCLUDED.events,
      session_id = EXCLUDED.session_id,
      updated_at = now()
  `;

  // ── 4. remediation_session ───────────────────────────────────────────────
  console.log(`[4/4] Upserting remediation_session ...`);
  const remStart = new Date(alertCreatedAt.getTime() + 5_000);   // +5s after alert
  const remEnd   = new Date(alertCreatedAt.getTime() + 145_000); // ~2.5 min later

  const steps = [
    {
      id: "step-1", type: "diagnose", status: "completed",
      message: "Read /api/checkout route handler + Stripe SDK usage",
      timestamp: new Date(remStart.getTime() + 4_000).toISOString(),
    },
    {
      id: "step-2", type: "generate_fix", status: "completed",
      message: "Wrote patch: idempotency_key from cart id + 10s timeout + async reconcile",
      timestamp: new Date(remStart.getTime() + 18_000).toISOString(),
    },
    {
      id: "step-3", type: "push", status: "completed",
      message: "Pushed branch fix/stripe-timeout-idempotency, opened PR #4521",
      timestamp: new Date(remStart.getTime() + 32_000).toISOString(),
    },
    {
      id: "step-4", type: "ci_passed", status: "completed",
      message: "CI green: TypeScript, unit, integration, e2e all pass",
      timestamp: new Date(remStart.getTime() + 110_000).toISOString(),
    },
  ];

  await sql`
    INSERT INTO remediation_sessions (
      id, alert_id, project_id, user_id,
      status, attempt, max_attempts,
      repo, branch, base_branch, pr_url, pr_number, merged_commit_sha,
      steps, confidence_score, merge_strategy,
      monitoring_status, fingerprint,
      created_at, updated_at
    ) VALUES (
      ${REM_UUID}, ${ALERT_UUID}, ${projectId}, ${userId},
      'completed', 1, 3,
      'orbita-pos/inariwatch', 'fix/stripe-timeout-idempotency', 'main',
      'https://github.com/orbita-pos/inariwatch/pull/4521', 4521, 'a3f8e21bc',
      ${JSON.stringify(steps)}::jsonb, 91, 'auto_merged',
      'passed', 'fulltrace-demo-fp-001',
      ${remStart.toISOString()}, ${remEnd.toISOString()}
    )
    ON CONFLICT (id) DO UPDATE SET
      steps = EXCLUDED.steps,
      status = EXCLUDED.status,
      updated_at = now()
  `;

  // ── Output ───────────────────────────────────────────────────────────────
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("FullTrace demo seeded successfully.");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`URL:  ${appUrl}/sessions/${SESSION_ID}`);
  console.log(`Org:  ${organizationId}`);
  console.log("");
  console.log("Make sure REPLAY_V2_ORGS env includes that org id (or '*').");
  console.log("Login as the user that owns the org, then open the URL.");
  console.log("");
  console.log("Expected:");
  console.log("  - Header shows session id + 90s duration");
  console.log("  - Side panels: Console · Network · Backend · AI · Errors · Comments");
  console.log("    (Backend + AI ONLY appear because the seed has data for them)");
  console.log("  - Backend tab: 8 events (HttpRequest, DbQuery, Exception)");
  console.log("  - AI tab: 6 events (alert · diagnosis · rem started · 4 steps · fix_merged)");
  console.log("  - Timeline shows AI track (orange) with markers");
  console.log("  - Click Backend / AI events → scrubber jumps to that ts");
  console.log("");
  console.log("Cleanup: npx tsx scripts/seed-fulltrace-demo.ts --clean");
}

// ── Synthetic event builders ───────────────────────────────────────────────

interface SubstrateEvent {
  seq: number;
  timestamp_ns: number;
  parent_seq: number | null;
  kind: Record<string, unknown>;
}

function buildBrowseEvents(baseNs: number): SubstrateEvent[] {
  // GET /api/products → SELECT FROM products → 200
  return [
    {
      seq: 0, timestamp_ns: baseNs, parent_seq: null,
      kind: { type: "HttpRequest", method: "GET", url: "/api/products" },
    },
    {
      seq: 1, timestamp_ns: baseNs + 80_000_000, parent_seq: 0,
      kind: { type: "DbQuery", query: "SELECT id, title, price FROM products WHERE active = true LIMIT 50" },
    },
    {
      seq: 2, timestamp_ns: baseNs + 150_000_000, parent_seq: 0,
      kind: { type: "HttpResponse", status: 200, duration_ms: 150 },
    },
  ];
}

function buildCheckoutFailureEvents(baseNs: number): SubstrateEvent[] {
  return [
    {
      seq: 0, timestamp_ns: baseNs, parent_seq: null,
      kind: { type: "HttpRequest", method: "POST", url: "/api/checkout" },
    },
    {
      seq: 1, timestamp_ns: baseNs + 50_000_000, parent_seq: 0,
      kind: { type: "DbQuery", query: "SELECT * FROM users WHERE id = $1" },
    },
    {
      seq: 2, timestamp_ns: baseNs + 90_000_000, parent_seq: 0,
      kind: { type: "DbQuery", query: "SELECT cart_id, total FROM carts WHERE user_id = $1" },
    },
    {
      seq: 3, timestamp_ns: baseNs + 130_000_000, parent_seq: 0,
      kind: { type: "HttpRequest", method: "POST", url: "https://api.stripe.com/v1/charges" },
    },
    {
      seq: 4, timestamp_ns: baseNs + 30_130_000_000, parent_seq: 3,
      kind: { type: "Exception", name: "StripeConnectionError", message: "Request timed out after 30000ms" },
    },
    {
      seq: 5, timestamp_ns: baseNs + 30_140_000_000, parent_seq: 0,
      kind: { type: "HttpResponse", status: 500, duration_ms: 30140 },
    },
  ];
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
