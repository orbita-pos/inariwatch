/**
 * End-to-end remediation smoke test using demo-store.
 *
 * Creates a synthetic alert for the InariWatch project that owns the
 * demo-store repo (orbita-pos/inariwatch-demo-store), inserts a
 * remediation_sessions row, and calls runRemediation() directly. The
 * agent will clone master, try to find the referenced file, read it,
 * and attempt a fix.
 *
 * This validates end-to-end that PR #1 (Responses API migration) and
 * PR #2 (system prompt overlays + spotlighting wrap) are wired up in
 * production and don't crash. We also get real cost/latency numbers
 * for the GPT-5.4 path.
 *
 * Usage:
 *   npx tsx scripts/test-remediation-e2e.ts
 *
 * Cleanup: the created alert is labeled `correlationData.e2eTest = true`
 * so `scripts/cleanup-baseline-seed.ts` (after trivially extending its
 * filter) or a direct DELETE can sweep it.
 */

import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

// Target repo — user confirmed this is the tester app.
const DEMO_REPO = "orbita-pos/inariwatch-demo-store";

// Plausible stack trace pointing to a REAL file in demo-store with a
// REAL latent bug (null checkout chaos path at line 66). The agent
// should find it with a grep for "shippingAddress.city.toUpperCase".
const ERROR_TITLE = "TypeError: Cannot read properties of undefined (reading 'city')";
const ERROR_BODY = `TypeError: Cannot read properties of undefined (reading 'city')
    at POST (app/api/checkout/route.ts:66:40)
    at NextMiddleware.run (.next/server/middleware.js:52:14)

Request: POST /api/checkout
Body: {"cartItems":[{"productId":"p_abc","quantity":1,"priceAtTime":19.99}],"couponCode":null}

Environment: production · Node 22.x · Next 16.0.3
User: u_test · Session: s_smoke

The shippingAddress field was not provided in the request body. Line 66 runs
shippingAddress.city.toUpperCase() without validating shippingAddress first,
so the deref throws. Similar unguarded path on line 67 (shippingAddress.zip.trim()).`;

async function main() {
  console.log(`🧪 Remediation E2E smoke test`);
  console.log(`   repo:   ${DEMO_REPO}`);
  console.log(`   bug:    app/api/checkout/route.ts:66 null checkout`);
  console.log();

  // 1. Locate the InariWatch project that owns demo-store via its github
  //    integration. We don't assume the project name — we look up by repo.
  const githubIntegrations = await db
    .select({
      projectId: schema.projectIntegrations.projectId,
      configEncrypted: schema.projectIntegrations.configEncrypted,
    })
    .from(schema.projectIntegrations)
    .where(eq(schema.projectIntegrations.service, "github"));

  // Decrypt each config and match the one pointing to demo-store.
  // Repos are stored in two possible shapes (seen in production):
  //   - cfg.repo (single) + cfg.owner
  //   - cfg.repos[] (array)
  //   - cfg.alertConfig.repoFilter[] (array) — seed-demo.ts pattern
  const { decryptConfig } = await import("../lib/crypto");
  let targetProjectId: string | null = null;
  for (const row of githubIntegrations) {
    try {
      const cfg = decryptConfig(row.configEncrypted) as Record<string, unknown>;
      const owner = cfg.owner as string | undefined;
      const repo = cfg.repo as string | undefined;
      const repos = cfg.repos as string[] | undefined;
      const alertCfg = cfg.alertConfig as { repoFilter?: string[] } | undefined;
      const repoFilter = alertCfg?.repoFilter ?? [];

      const candidates = new Set<string>();
      if (owner && repo) candidates.add(`${owner}/${repo}`);
      repos?.forEach((r) => candidates.add(r));
      repoFilter.forEach((r) => candidates.add(r));

      if (candidates.has(DEMO_REPO)) {
        targetProjectId = row.projectId;
        break;
      }
    } catch {
      // Skip integrations with unreadable config
    }
  }

  if (!targetProjectId) {
    console.error(`❌ No InariWatch project is connected to ${DEMO_REPO}.`);
    console.error(`   Connect the repo under a project first, then retry.`);
    process.exit(1);
  }

  const [project] = await db
    .select({ id: schema.projects.id, name: schema.projects.name, userId: schema.projects.userId })
    .from(schema.projects)
    .where(eq(schema.projects.id, targetProjectId))
    .limit(1);

  console.log(`Target project: ${project.name} (${project.id})`);
  console.log();

  // 2. Create the synthetic alert.
  const [alert] = await db
    .insert(schema.alerts)
    .values({
      projectId: project.id,
      severity: "critical",
      title: ERROR_TITLE,
      body: ERROR_BODY,
      sourceIntegrations: ["sentry"],
      correlationData: {
        seed: true,
        e2eTest: true,
        testRun: new Date().toISOString(),
      },
    })
    .returning();

  console.log(`✓ Alert created: ${alert.id.slice(0, 8)}…`);

  // 3. Insert remediation_sessions row.
  const [remSession] = await db
    .insert(schema.remediationSessions)
    .values({
      alertId: alert.id,
      projectId: project.id,
      userId: project.userId,
      status: "analyzing",
      attempt: 1,
      maxAttempts: 3,
      steps: [],
    })
    .returning();

  console.log(`✓ Session created: ${remSession.id.slice(0, 8)}…`);
  console.log();
  console.log(`  Dashboard: https://app.inariwatch.com/admin/ai/session/${remSession.id}`);
  console.log();

  // 4. Fire runRemediation directly. The pipeline will emit steps that we
  //    log locally; production SSE readers won't see them (this is an
  //    offline test), but the steps get persisted to the DB.
  const { runRemediation } = await import("../lib/ai/remediate");

  const t0 = Date.now();
  let eventCount = 0;
  const interestingEvents = new Set([
    "container_turn",
    "agentic_turn",
    "container_tool",
    "agentic_tool",
    "container_text",
    "agentic_text",
    "container_done",
    "agentic_done",
    "container_error",
    "agentic_error",
    "container_agent",
    "error",
    "step",
    "done",
  ]);

  const emit = (event: string, data: unknown): void => {
    eventCount++;
    if (interestingEvents.has(event)) {
      const payload = JSON.stringify(data).slice(0, 160);
      console.log(`  [${String(eventCount).padStart(3, " ")}] ${event}  ${payload}`);
    }
  };

  try {
    console.log(`▶ Running remediation pipeline…\n`);
    await runRemediation(remSession.id, emit);
    const dtSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✅ Pipeline completed in ${dtSec}s (${eventCount} events emitted)`);
  } catch (err) {
    const dtSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n❌ Pipeline threw after ${dtSec}s:`);
    console.log(`   ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Read back the session + its ai_usage_logs for a summary.
  const [finalSession] = await db
    .select()
    .from(schema.remediationSessions)
    .where(eq(schema.remediationSessions.id, remSession.id))
    .limit(1);

  const calls = await db
    .select({
      feature: schema.aiUsageLogs.feature,
      model: schema.aiUsageLogs.model,
      inputTokens: schema.aiUsageLogs.inputTokens,
      cachedInputTokens: schema.aiUsageLogs.cachedInputTokens,
      outputTokens: schema.aiUsageLogs.outputTokens,
      costUsd: schema.aiUsageLogs.costUsd,
      durationMs: schema.aiUsageLogs.durationMs,
      response: schema.aiUsageLogs.response,
    })
    .from(schema.aiUsageLogs)
    .where(eq(schema.aiUsageLogs.remediationSessionId, remSession.id));

  const totalCost = calls.reduce((s, c) => s + Number(c.costUsd ?? 0), 0);
  const totalInput = calls.reduce((s, c) => s + (c.inputTokens ?? 0), 0);
  const totalCached = calls.reduce((s, c) => s + (c.cachedInputTokens ?? 0), 0);
  const totalOutput = calls.reduce((s, c) => s + (c.outputTokens ?? 0), 0);
  const cacheHit = totalInput > 0 ? ((totalCached / totalInput) * 100).toFixed(0) : "0";
  const gpt5Calls = calls.filter((c) => c.model.toLowerCase().startsWith("gpt-5")).length;

  console.log(`\n───── Session summary ─────`);
  console.log(`  Final status:   ${finalSession.status}`);
  console.log(`  Steps:          ${(finalSession.steps as unknown[]).length}`);
  console.log(`  AI calls:       ${calls.length}`);
  console.log(`  gpt-5.x calls:  ${gpt5Calls} (validates PR #1 Responses API path)`);
  console.log(`  Total cost:     $${totalCost.toFixed(5)}`);
  console.log(`  Tokens:         ${totalInput} in (${totalCached} cached, ${cacheHit}%) · ${totalOutput} out`);

  if (gpt5Calls > 0) {
    console.log(`\n✅ PR #1 validated — Responses API path exercised ${gpt5Calls} times.`);
  } else {
    console.log(`\n⚠  No gpt-5.x calls — pipeline stopped before hitting the remediation model.`);
    console.log(`    Look at the session view for the step that stopped it.`);
  }

  console.log(`\n  View session: https://app.inariwatch.com/admin/ai/session/${remSession.id}`);
  console.log(`  Cleanup:      DELETE FROM alerts WHERE id = '${alert.id}';`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
