/**
 * Seed a Gate 13 "Behavioral Drift" end-to-end scenario for a user's
 * dashboard review.
 *
 * Creates:
 *   - user (resolved by --email, must already exist)
 *   - project "Drift Demo" (idempotent by slug)
 *   - 60 substrate_recordings over the last 7 days (healthy baseline)
 *   - 60 session_endpoint_metrics — enough to beat the 50-sample
 *     sufficiency threshold for one endpoint
 *   - 1 alert  +  1 remediation_session
 *   - 1 behavioral_drift_runs row pre-populated with realistic mix of
 *     drifted + improved + neutral endpoints — bypasses the worker so
 *     the reviewer sees the completed card without needing WORKER_URL.
 *
 * Scenario: the baseline endpoint `POST /api/checkout/:id` normally
 * makes 3 db queries + 2 external HTTP calls to Stripe/Segment at ~85ms
 * p95 latency. The proposed fix adds a NEW downstream call to
 * fraud.example.com (structural drift) and increases latency 42%
 * (magnitude drift). Another endpoint `GET /api/orders/:id` improves
 * (fewer db queries). A third endpoint is neutral.
 *
 * Outcome: drifted 1/3 = 33.3%, above 20% threshold → gate FAILS.
 *
 * Usage:
 *   cd web && npx tsx scripts/seed-drift-demo.ts --email <email>
 *
 * Re-running is safe — the script uses deterministic ids derived from
 * the email so repeat runs overwrite prior seed data.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { resolve as resolvePath } from "node:path";

loadEnv({ path: resolvePath(process.cwd(), ".env.local") });
loadEnv();

import { db } from "@/lib/db";
import {
  alerts,
  projects,
  remediationSessions,
  substrateRecordings,
  sessionEndpointMetrics,
  behavioralDriftRuns,
  users,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// ── CLI ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const EMAIL = argOf("--email");

if (!EMAIL) {
  console.error("Usage: npx tsx scripts/seed-drift-demo.ts --email <email>");
  process.exit(1);
}

/** Deterministic v4-shaped UUID from a seed string — lets us upsert by key. */
function seededUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  // Carve an RFC-4122 v4 shape: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  // where y ∈ {8,9,a,b}. We take 32 hex chars, force the version + variant nibbles.
  return (
    h.slice(0, 8) + "-" +
    h.slice(8, 12) + "-" +
    "4" + h.slice(13, 16) + "-" +
    ["8", "9", "a", "b"][parseInt(h[16], 16) % 4] + h.slice(17, 20) + "-" +
    h.slice(20, 32)
  );
}

async function main() {
  console.log(`\nSeeding Gate 13 drift demo for ${EMAIL} ...\n`);

  // ── 1. User ───────────────────────────────────────────────────────────
  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, EMAIL as string))
    .limit(1);
  if (!user) {
    console.error(`User ${EMAIL} not found. Register at app.inariwatch.com first.`);
    process.exit(1);
  }
  console.log(`  ✓ user: ${user.id} (${user.name ?? "no name"})`);

  // ── 2. Project ────────────────────────────────────────────────────────
  const projectId = seededUuid(`drift-demo:${user.id}:project`);
  const [existingProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!existingProject) {
    await db.insert(projects).values({
      id: projectId,
      userId: user.id,
      name: "Drift Demo",
      slug: `drift-demo-${user.id.slice(0, 8)}`,
      description: "Seed project for Gate 13 behavioral drift review",
    });
  }
  console.log(`  ✓ project: ${projectId}`);

  // ── 3. Clear prior seed data so re-runs are clean ─────────────────────
  // The recordings, alert, remediation, and drift run all live under
  // deterministic ids so we can nuke them before reseeding.
  const alertId = seededUuid(`drift-demo:${user.id}:alert`);
  const remediationId = seededUuid(`drift-demo:${user.id}:remediation`);
  const fixCommitSha = "d13f0001gate13demofixcommit000000000abcd";

  await db
    .delete(behavioralDriftRuns)
    .where(eq(behavioralDriftRuns.alertId, alertId));
  await db
    .delete(sessionEndpointMetrics)
    .where(eq(sessionEndpointMetrics.projectId, projectId));
  await db
    .delete(substrateRecordings)
    .where(eq(substrateRecordings.projectId, projectId));
  await db.delete(remediationSessions).where(eq(remediationSessions.id, remediationId));
  await db.delete(alerts).where(eq(alerts.id, alertId));

  // ── 4. Baseline: 60 healthy substrate_recordings + session metrics ────
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const baselineEndpoint = "POST /api/checkout/:id";
  const baselineDownstreams = [
    "postgres:SELECT users",
    "postgres:UPDATE orders",
    "postgres:INSERT audit_log",
    "https://api.stripe.com/v1/charges",
    "https://api.segment.io/v1/track",
  ];

  const recordingRows: (typeof substrateRecordings.$inferInsert)[] = [];
  const metricRows: (typeof sessionEndpointMetrics.$inferInsert)[] = [];

  for (let i = 0; i < 60; i++) {
    const recordingId = seededUuid(`drift-demo:${user.id}:rec:${i}`);
    // Spread over the last 7 days so all fall in the default window.
    const capturedAt = new Date(now - Math.floor((i / 60) * 7 * DAY_MS));

    recordingRows.push({
      id: recordingId,
      recordingId: `drift-demo-${recordingId.slice(0, 8)}`,
      projectId,
      startedAt: capturedAt,
      endedAt: new Date(capturedAt.getTime() + 100),
      eventCount: 0,
      runtime: "node",
    });

    // Baseline metrics: latency ~60-110ms (p95 ~105), 3 db queries, 2
    // external http, all 200 responses, stable downstream set.
    const jitter = (i * 37) % 51; // deterministic pseudo-random 0..50
    const latencyMs = 60 + jitter; // 60..110ms
    metricRows.push({
      substrateRecordingId: recordingId,
      projectId,
      endpointSignature: baselineEndpoint,
      endpointUrlRaw: `/api/checkout/order_${1000 + i}`,
      capturedAt,
      healthy: true,
      latencyMs,
      dbQueryCount: 3,
      externalHttpCount: 2,
      topStatus: 200,
      downstreamSignatures: baselineDownstreams,
    });
  }

  await db.insert(substrateRecordings).values(recordingRows);
  await db.insert(sessionEndpointMetrics).values(metricRows);
  console.log(`  ✓ baseline: 60 substrate_recordings + session_endpoint_metrics for ${baselineEndpoint}`);

  // ── 5. Alert + remediation ────────────────────────────────────────────
  const crashTs = Date.now() - 2 * 60 * 1000; // 2 min ago
  const committedTs = crashTs - 37 * 60 * 1000;

  const correlationData = {
    git: {
      commit: "8c4f1e2a9d3b7c6f5a4e3d2c1b0a9f8e7d6c5b4a",
      branch: "radar/fix-drift-demo",
      message: "fix(checkout): add Stripe 502 retry with idempotency + fraud check pre-flight",
      timestamp: new Date(committedTs).toISOString(),
      dirty: false,
    },
    breadcrumbs: [
      { timestamp: new Date(crashTs - 9500).toISOString(), category: "fetch",   level: "info",    message: "GET /api/auth/session" },
      { timestamp: new Date(crashTs - 9420).toISOString(), category: "fetch",   level: "info",    message: "GET /api/auth/session → 200 (78ms)" },
      { timestamp: new Date(crashTs - 7200).toISOString(), category: "console", level: "info",    message: "User clicked 'Pay $50.00'" },
      { timestamp: new Date(crashTs - 7180).toISOString(), category: "fetch",   level: "info",    message: "POST /api/cart/validate" },
      { timestamp: new Date(crashTs - 6900).toISOString(), category: "fetch",   level: "info",    message: "POST /api/cart/validate → 200 (280ms)" },
      { timestamp: new Date(crashTs - 4800).toISOString(), category: "fetch",   level: "info",    message: "POST /api/checkout/order_4182" },
      { timestamp: new Date(crashTs - 3200).toISOString(), category: "fetch",   level: "warning", message: "Stripe API → 502 Bad Gateway" },
      { timestamp: new Date(crashTs - 3180).toISOString(), category: "console", level: "info",    message: "Retrying Stripe charge with new idempotency key" },
      { timestamp: new Date(crashTs - 2900).toISOString(), category: "fetch",   level: "warning", message: "Stripe API → 502 Bad Gateway (retry 1)" },
      { timestamp: new Date(crashTs - 1400).toISOString(), category: "fetch",   level: "error",   message: "Stripe API → 502 Bad Gateway (retry 2 exhausted)" },
      { timestamp: new Date(crashTs - 80).toISOString(),   category: "console", level: "error",   message: "TypeError: Cannot read property 'charge' of undefined" },
      { timestamp: new Date(crashTs - 10).toISOString(),   category: "console", level: "error",   message: "at POST /api/checkout/:id (lib/stripe/charge.ts:89)" },
    ],
    env: {
      runtime: "node",
      node: "v20.11.1",
      platform: "linux",
      arch: "x64",
      app_version: "3.2.1",
      heapUsedMB: 198,
      heapTotalMB: 256,
      uptime: 8421,
    },
    user: {
      id: "usr_9f3a2b8c",
      role: "customer",
      plan: "pro",
    },
    request: {
      method: "POST",
      url: "https://app.inariwatch.com/api/checkout/order_4182",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36",
        "x-forwarded-for": "[REDACTED]",
        "authorization": "[REDACTED]",
        "cookie": "[REDACTED]",
        "idempotency-key": "idem_01H8X5Y2Z9",
      },
      query: {},
      body: {
        amount: 5000,
        currency: "usd",
        source: "card_1KQr2..",
        metadata: { plan: "pro", order_id: "order_4182" },
      },
      ip: "[REDACTED]",
    },
  };

  const aiReasoning = [
    "**Root cause:** POST /api/checkout/:id crashes when the Stripe API returns a 502 twice in a row. The retry handler constructs a fresh idempotency key each time instead of reusing the original, so Stripe treats retries as brand-new charge attempts. When Stripe eventually responds with a non-Charge object on the second retry, the handler dereferences `.charge` on undefined and throws a TypeError.",
    "",
    "**Evidence:** Breadcrumbs show two consecutive 502s from Stripe before the TypeError fires. The stack points at lib/stripe/charge.ts:89 where `result.charge.id` is accessed without guarding the retry fallback path. Heap usage is elevated (77% of total) but not the proximate cause.",
    "",
    "**Fix direction:** (1) reuse the original idempotency-key across retries so Stripe can dedupe. (2) check `result?.charge` before dereferencing. (3) add a pre-flight fraud check so repeated 502s don't cascade into duplicate charge attempts downstream.",
    "",
    "**Business impact:** HIGH — this is the primary checkout path for Pro plan users. ~12 active customer sessions shared this fingerprint in the last hour before the alert fired.",
  ].join("\n");

  await db.insert(alerts).values({
    id: alertId,
    projectId,
    title: "TypeError in POST /api/checkout/:id after Stripe 502 retry",
    body: "Stripe 502 retry exhausted — TypeError: Cannot read property 'charge' of undefined at lib/stripe/charge.ts:89. Fresh idempotency-key on retry caused Stripe to process the second attempt as a new charge, response shape diverged on failure, dereference crashed.",
    severity: "critical",
    fingerprint: `drift-demo-fingerprint-${user.id.slice(0, 8)}`,
    sourceIntegrations: ["capture"],
    alertType: "error",
    aiReasoning,
    correlationData,
    sessionId: `drift-demo-session-${user.id.slice(0, 8)}`,
  });
  console.log(`  ✓ alert: ${alertId} (with aiReasoning + correlationData)`);

  await db.insert(remediationSessions).values({
    id: remediationId,
    alertId,
    projectId,
    userId: user.id,
    status: "completed",
    steps: [],
    repo: "orbita-pos/drift-demo",
    branch: "radar/fix-drift-demo",
    baseBranch: "main",
    mergedCommitSha: fixCommitSha,
    confidenceScore: 82,
  });
  console.log(`  ✓ remediation: ${remediationId}`);

  // ── 6. Pre-compute the drift result (bypasses worker) ─────────────────
  // Three endpoints analyzed:
  //   1. POST /api/checkout/:id  — DRIFTED: new downstream + latency regression
  //   2. GET  /api/orders/:id    — IMPROVED: fewer db queries
  //   3. POST /api/invoices      — neutral
  const driftedEndpoint = {
    signature: "POST /api/checkout/:id",
    magnitudeScore: 0.42,
    hasStructuralDrift: true,
    baselineSamples: 60,
    fixSamples: 8,
    structural: {
      missingDownstreams: [],
      newDownstreams: ["https://fraud.example.com/v1/check"],
      statusShift: null,
    },
    magnitude: {
      latencyMs: { baselineP95: 105, fixP95: 149, deltaPct: 0.42, flagged: true },
      dbQueryCount: { baselineP95: 3, fixP95: 3, deltaPct: 0, flagged: false },
      externalHttpCount: { baselineP95: 2, fixP95: 3, deltaPct: 0.5, flagged: true },
    },
  };

  const improvedEndpoint = {
    signature: "GET /api/orders/:id",
    magnitudeScore: 0,
    hasStructuralDrift: false,
    baselineSamples: 52,
    fixSamples: 8,
    structural: { missingDownstreams: [], newDownstreams: [], statusShift: null },
    magnitude: {
      latencyMs: { baselineP95: 44, fixP95: 33, deltaPct: -0.25, flagged: false },
      dbQueryCount: { baselineP95: 4, fixP95: 2, deltaPct: -0.5, flagged: false },
      externalHttpCount: { baselineP95: 0, fixP95: 0, deltaPct: null, flagged: false },
    },
  };

  await db.insert(behavioralDriftRuns).values({
    id: seededUuid(`drift-demo:${user.id}:driftrun`),
    alertId,
    remediationId,
    fixCommitSha,
    windowDays: 7,
    status: "completed",
    analyzedEndpoints: 3,
    insufficientDataEndpoints: 0,
    driftedEndpoints: 1,
    improvedEndpoints: 1,
    maxDriftScore: 0.42,
    thresholdDriftedPercent: 20,
    passed: false, // 1/3 = 33.3% > 20% threshold
    endpointDetails: [driftedEndpoint],
    improvementsDetected: [improvedEndpoint],
    completedAt: new Date(),
  });
  console.log(`  ✓ behavioral_drift_runs: 3 analyzed, 1 drifted, 1 improved (33.3% > 20% → FAIL)`);

  console.log("");
  console.log("─────────────────────────────────────────────────");
  console.log(`Review at:  https://app.inariwatch.com/alerts/${alertId}`);
  console.log(`Local dev:  http://localhost:3000/alerts/${alertId}`);
  console.log("");
  console.log("Expected in the card:");
  console.log("  - Red 'Drift detected' chip");
  console.log("  - 3 analyzed / 1 drifted (33.3%) / 1 improved");
  console.log("  - Max magnitude: 42.0%");
  console.log("  - 'Show drifted endpoints (1)' → POST /api/checkout/:id");
  console.log("      latency +42%, external +50%, +1 new downstream (fraud.example.com)");
  console.log("  - 'Show improvements (1)' → GET /api/orders/:id");
  console.log("      latency -25%, db queries -50%");
  console.log("─────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
