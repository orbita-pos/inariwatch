/**
 * InariWatch — Seed demo remediation data
 *
 * Creates a realistic completed remediation session with all stages,
 * gates, and telemetry for the demo account. Used to capture landing
 * page screenshots.
 *
 * Usage:
 *   npx tsx scripts/seed-demo-remediation.ts
 */

import { config } from "dotenv";
import path from "path";

config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const DEMO_EMAIL = "demo@inariwatch.com";

// ── Realistic remediation steps (the pipeline terminal) ────────────────────

function makeSteps(): schema.RemediationStep[] {
  const base = Date.now() - 8 * 60 * 1000; // 8 minutes ago
  const t = (offsetMs: number) => new Date(base + offsetMs).toISOString();

  return [
    {
      id: "step_001",
      type: "analyze",
      message: "Connecting to jesusbrdev/inariwatch-app...",
      status: "completed",
      timestamp: t(0),
    },
    {
      id: "step_002",
      type: "gather_context",
      message: "Gathered context from: Sentry (stack trace + 12 breadcrumbs), Vercel (deploy dpl_8xK2), GitHub CI (3 recent runs), Code RAG (4 relevant files)",
      status: "completed",
      timestamp: t(3000),
    },
    {
      id: "step_003",
      type: "incident_check",
      message: "No related incidents detected — proceeding as leader",
      status: "completed",
      timestamp: t(4000),
    },
    {
      id: "step_004",
      type: "diagnose",
      message: "Diagnosis (87% confidence → calibrated 82%): TypeError in auth middleware — req.session is undefined because the session middleware was removed during a refactor in commit abc1234. The auth route at app/api/auth/route.ts:32 assumes req.session exists but it was replaced with NextAuth getServerSession().",
      status: "completed",
      timestamp: t(8000),
    },
    {
      id: "step_005",
      type: "anti_patterns",
      message: "Checked 2 past failed fixes for this error pattern — avoiding: direct session object patching (caused circular import)",
      status: "completed",
      timestamp: t(9000),
    },
    {
      id: "step_006",
      type: "file_locks",
      message: "Acquired locks on 2 files: app/api/auth/route.ts, lib/auth/session.ts",
      status: "completed",
      timestamp: t(9500),
    },
    {
      id: "step_007",
      type: "read_code",
      message: "Read 3 file(s): app/api/auth/route.ts (142 lines), lib/auth/session.ts (87 lines), middleware.ts (56 lines)",
      status: "completed",
      timestamp: t(12000),
    },
    {
      id: "step_008",
      type: "generate_fix",
      message: "Fix: Replace direct req.session access with getServerSession(authOptions) in auth route handler. Added null check for session object.",
      status: "completed",
      timestamp: t(22000),
    },
    {
      id: "step_009",
      type: "security_scan",
      message: "Security scan passed — 3 layers: ESLint (0 findings), Pattern scan (0 findings), AI review (0 HIGH, 1 INFO: consider adding rate limiting to auth endpoint)",
      status: "completed",
      timestamp: t(28000),
    },
    {
      id: "step_010",
      type: "self_review",
      message: "✅ Self-review: 92/100 — approve\n• Minimal change (2 files, 8 lines)\n• Correctly uses getServerSession() instead of deprecated req.session\n• Null check prevents future crashes\n• No side effects on other routes",
      status: "completed",
      timestamp: t(35000),
    },
    {
      id: "step_011",
      type: "test_gen",
      message: "Generated 1 regression test: test/auth-session.test.ts — verifies getServerSession is called and null session returns 401",
      status: "completed",
      timestamp: t(42000),
    },
    {
      id: "step_012",
      type: "push",
      message: "Pushed branch radar/fix-session-undefined-1712324800000 → 2 files changed, 8 insertions(+), 3 deletions(-)",
      status: "completed",
      timestamp: t(48000),
    },
    {
      id: "step_013",
      type: "ci_wait",
      message: "CI passed ✅ (2m 34s) — 4/4 checks passed: lint, typecheck, test, build",
      status: "completed",
      timestamp: t(200000),
    },
    {
      id: "step_014",
      type: "staging",
      message: "Staging verification passed ✅\n• Deployed to fix-abc12.staging.inariwatch.com (TTL 5m)\n• Browser bot replayed 8 HTTP requests + 3 UI actions\n• Response body deep diff: 0 errors, 0 warnings\n• AI visual analysis: before (broken auth page) → after (login working correctly)\n• Selector replay: 3/3 actions succeeded",
      status: "completed",
      timestamp: t(260000),
    },
    {
      id: "step_015",
      type: "gates",
      message: "All 11 safety gates passed ✅\n① auto_merge: ✓  ② ci: ✓  ③ confidence: ✓ (82%)  ④ lines: ✓ (8)  ⑤ review: ✓ (92)  ⑥ simulate: ✓ (risk 15)  ⑦ eap: ✓  ⑧ predict: ✓ (risk 12)  ⑨ security: ✓  ⑩ replay: ✓  ⑪ staging: ✓",
      status: "completed",
      timestamp: t(265000),
    },
    {
      id: "step_016",
      type: "create_pr",
      message: "PR #42 created — \"fix: replace req.session with getServerSession in auth route\"\nContext sources: sentry: ✓, vercel: ✓, github: ✓, datadog: ✓, substrate: ✓, eap: ✓",
      status: "completed",
      timestamp: t(268000),
    },
    {
      id: "step_017",
      type: "auto_merge",
      message: "PR #42 auto-merged successfully ✅",
      status: "completed",
      timestamp: t(272000),
    },
    {
      id: "step_018",
      type: "monitoring",
      message: "Post-merge monitoring complete ✅ (10 min)\n• Phase 1 (canary_fast 0-3m): 6 checks, 0 regressions\n• Phase 2 (canary_normal 3-7m): 4 checks, 0 regressions\n• Phase 3 (canary_slow 7-10m): 2 checks, 0 regressions\n• Error rate: baseline 0.2% → post-merge 0.1% (-50%)\n• No fingerprint recurrence detected",
      status: "completed",
      timestamp: t(872000),
    },
  ];
}

// ── Gate results ────────────────────────────────────────────────────────────

const GATE_RESULTS = [
  { gateName: "auto_merge_enabled", result: true, durationMs: 2 },
  { gateName: "ci_passed", result: true, durationMs: 154000 },
  { gateName: "confidence", result: true, durationMs: 5, errorReason: null },
  { gateName: "lines_changed", result: true, durationMs: 3 },
  { gateName: "self_review", result: true, durationMs: 12000 },
  { gateName: "substrate_simulate", result: true, durationMs: 8000 },
  { gateName: "eap_chain_verified", result: true, durationMs: 1200 },
  { gateName: "prediction_safe", result: true, durationMs: 3500 },
  { gateName: "security_scan", result: true, durationMs: 6800 },
  { gateName: "substrate_replay", result: true, durationMs: 9200 },
  { gateName: "e2e_staging", result: true, durationMs: 45000 },
];

async function main() {
  console.log("🌱 Seeding demo remediation data...\n");

  // ── Find demo user ──────────────────────────────────────────────────────
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, DEMO_EMAIL))
    .limit(1);

  if (!user) {
    console.error(`❌ User ${DEMO_EMAIL} not found.`);
    process.exit(1);
  }
  console.log(`✓ Found user: ${user.email}`);

  // ── Find first project ──────────────────────────────────────────────────
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.userId, user.id))
    .limit(1);

  if (!project) {
    console.error("❌ No projects found for demo user. Run seed-demo.ts first.");
    process.exit(1);
  }
  console.log(`✓ Using project: ${project.name} (${project.id})`);

  // ── Find the critical Sentry alert (unhandled exception spike) ──────────
  const [alert] = await db
    .select()
    .from(schema.alerts)
    .where(
      and(
        eq(schema.alerts.projectId, project.id),
        eq(schema.alerts.severity, "critical"),
      )
    )
    .orderBy(desc(schema.alerts.createdAt))
    .limit(1);

  if (!alert) {
    console.error("❌ No critical alerts found. Run seed-demo.ts first.");
    process.exit(1);
  }
  console.log(`✓ Using alert: "${alert.title}" (${alert.id})`);

  // ── Update alert with AI reasoning ──────────────────────────────────────
  await db
    .update(schema.alerts)
    .set({
      aiReasoning:
        "This is a TypeError caused by accessing `req.session` which is undefined. The root cause is a recent refactor (commit abc1234) that removed the legacy session middleware but didn't update all consumers. The auth route at `app/api/auth/route.ts:32` still assumes `req.session` exists. The fix is to migrate to `getServerSession(authOptions)` from NextAuth. This is a **critical** issue affecting 12 users in the last 10 minutes with 47 error occurrences. Confidence: high — the stack trace points directly to the removed middleware.",
      fingerprint: "sha256_session_undefined_auth_route",
    })
    .where(eq(schema.alerts.id, alert.id));
  console.log("  ✓ Updated alert with AI reasoning");

  // ── Delete existing remediation for this alert (idempotent) ─────────────
  await db
    .delete(schema.remediationSessions)
    .where(eq(schema.remediationSessions.alertId, alert.id));

  // ── Create completed remediation session (raw SQL to avoid missing columns) ─
  const now = new Date();
  const startedAt = new Date(now.getTime() - 15 * 60 * 1000);

  const steps = JSON.stringify(makeSteps());
  const fileChanges = JSON.stringify([
    {
      path: "app/api/auth/route.ts",
      content: `import { getServerSession } from "next-auth/next";\nimport { authOptions } from "@/lib/auth";\nimport { NextResponse } from "next/server";\n\nexport async function GET(req: Request) {\n  const session = await getServerSession(authOptions);\n  if (!session) {\n    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });\n  }\n  return NextResponse.json({ user: session.user });\n}`,
    },
    {
      path: "lib/auth/session.ts",
      content: `import { getServerSession } from "next-auth/next";\nimport { authOptions } from "./config";\n\nexport async function requireSession() {\n  const session = await getServerSession(authOptions);\n  if (!session) throw new Error("Unauthorized");\n  return session;\n}`,
    },
  ]);
  const selfReview = JSON.stringify({ score: 92, concerns: [], recommendation: "approve" });
  const context = JSON.stringify({
    sentryStackTrace: "TypeError: Cannot read properties of undefined (reading 'session')\n    at GET (app/api/auth/route.ts:32:18)\n    at handler (node_modules/next/dist/server/route-modules/app-route/module.js:254:30)",
    vercelBuildLogs: "Build successful — deploy dpl_8xK2mNvR\nRuntime: Node.js 20.x\nRegion: iad1",
    githubCILogs: "Run #312: lint ✓ | typecheck ✓ | test ✓ | build ✓ — All 4 checks passed in 2m 34s",
    codebaseContext: "auth/route.ts uses legacy req.session pattern. lib/auth/session.ts exports requireSession(). middleware.ts handles route protection.",
    securityScan: { passed: true, highCount: 0, mediumCount: 0, findings: [] },
  });

  const insertResult = await sql`
    INSERT INTO remediation_sessions (
      alert_id, project_id, user_id, status, attempt, max_attempts,
      repo, branch, base_branch, pr_url, pr_number,
      file_changes, steps, confidence_score, self_review_result,
      merge_strategy, merged_commit_sha, monitoring_until, monitoring_status,
      fingerprint, context, simulate_risk_score,
      proposed_at, created_at, updated_at
    ) VALUES (
      ${alert.id}, ${project.id}, ${user.id}, 'completed', 1, 3,
      'jesusbrdev/inariwatch-app', 'radar/fix-session-undefined-1712324800000', 'main',
      'https://github.com/jesusbrdev/inariwatch-app/pull/42', 42,
      ${fileChanges}::jsonb, ${steps}::jsonb, 87, ${selfReview}::jsonb,
      'auto_merged', 'a1b2c3d4e5f6789012345678901234567890abcd',
      ${new Date(now.getTime() - 2 * 60 * 1000).toISOString()}::timestamptz, 'passed',
      'sha256_session_undefined_auth_route', ${context}::jsonb, 15,
      ${new Date(startedAt.getTime() + 5 * 60 * 1000).toISOString()}::timestamptz,
      ${startedAt.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    ) RETURNING id
  `;

  const sessionId = insertResult[0].id;
  console.log(`  ✓ Created remediation session: ${sessionId}`);

  // ── Seed gate telemetry (skip if table not migrated) ─────────────────────
  try {
    for (const gate of GATE_RESULTS) {
      await db.insert(schema.gateTelemetry).values({
        projectId: project.id,
        gateName: gate.gateName,
        result: gate.result,
        errorReason: null,
        durationMs: gate.durationMs,
      });
    }
    console.log(`  ✓ Created ${GATE_RESULTS.length} gate telemetry records`);
  } catch {
    console.log("  ⊘ gate_telemetry table not migrated — skipping");
  }

  // ── Seed confidence calibration (skip if table not migrated) ────────────
  try {
    const calibrationPoints = [
      { predicted: 90, actual: true },
      { predicted: 85, actual: true },
      { predicted: 75, actual: true },
      { predicted: 92, actual: true },
      { predicted: 60, actual: false },
      { predicted: 88, actual: true },
      { predicted: 70, actual: true },
      { predicted: 45, actual: false },
      { predicted: 82, actual: true },
      { predicted: 78, actual: true },
      { predicted: 95, actual: true },
      { predicted: 55, actual: false },
    ];

    for (const cp of calibrationPoints) {
      await db.insert(schema.confidenceCalibration).values({
        projectId: project.id,
        predictedConfidence: cp.predicted,
        actualOutcome: cp.actual,
      });
    }
    console.log(`  ✓ Created ${calibrationPoints.length} calibration points`);
  } catch {
    console.log("  ⊘ confidence_calibration table not migrated — skipping");
  }

  // ── Mark alert as resolved ──────────────────────────────────────────────
  await db
    .update(schema.alerts)
    .set({
      isResolved: true,
      resolvedAt: now,
    })
    .where(eq(schema.alerts.id, alert.id));
  console.log("  ✓ Marked alert as resolved");

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n✅ Demo remediation seed complete!");
  console.log(`   Session: ${sessionId}`);
  console.log(`   Alert:   ${alert.title}`);
  console.log(`   Status:  completed (auto-merged, monitoring passed)`);
  console.log(`   PR:      #42 — fix: replace req.session with getServerSession`);
  console.log(`   Gates:   11/11 passed`);
  console.log("\nNow run the screenshot capture:");
  console.log(
    "  DEMO_URL=https://app.inariwatch.com DEMO_EMAIL=demo@inariwatch.com DEMO_PASSWORD=Demo1234! npx tsx web/scripts/capture-screenshots.ts"
  );
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
