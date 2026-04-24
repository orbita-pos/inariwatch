/**
 * E2E validation for PR #3 — apply_patch envelope tool.
 *
 * Points a synthetic alert at `app/api/ping-broken/route.ts` in
 * inariwatch-demo-store, which has a REAL bug on master:
 * `name.toUpperCase()` where `name` can be null. The agent should
 * find the file, read it, and emit a tiny apply_patch (not a
 * write_file).
 *
 * Validates:
 *   - Pipeline end-to-end doesn't crash
 *   - Agent CHOOSES apply_patch over write_file (this is what PR #3 asserts)
 *   - If apply_patch is used, the patch succeeds (no parse/match errors)
 *   - PR #1 Responses API path is exercised on gpt-5.x calls
 *   - PR #2 overlays applied (we check by looking at the prompt stored
 *     in ai_usage_logs — the first 200 chars should contain <immutable_rules>)
 *
 * Usage:
 *   npx tsx scripts/test-apply-patch-e2e.ts
 *
 * Cleanup after the test:
 *   - Delete the demo alert (script prints the DELETE command at the end)
 *   - Optionally revert the ping-broken fixture with:
 *       cd ~/desktop/tester && git revert HEAD && git push
 */

import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const DEMO_REPO = "orbita-pos/inariwatch-demo-store";
const ERROR_TITLE = "TypeError: Cannot read properties of null (reading 'toUpperCase')";
const ERROR_BODY = `TypeError: Cannot read properties of null (reading 'toUpperCase')
    at GET (app/api/ping-broken/route.ts:12:28)
    at NextMiddleware.run (.next/server/middleware.js:52:14)

Request: GET /api/ping-broken
Query: (empty, no ?name= provided)

The route calls url.searchParams.get("name") which returns null when the
query param is missing, then calls .toUpperCase() on it. Need a null
check before using name.`;

async function main() {
  console.log(`🧪 apply_patch E2E test`);
  console.log(`   repo:   ${DEMO_REPO}`);
  console.log(`   bug:    app/api/ping-broken/route.ts:12 null ref before .toUpperCase()`);
  console.log();

  // Resolve demo-store project.
  const githubIntegrations = await db
    .select({
      projectId: schema.projectIntegrations.projectId,
      configEncrypted: schema.projectIntegrations.configEncrypted,
    })
    .from(schema.projectIntegrations)
    .where(eq(schema.projectIntegrations.service, "github"));

  const { decryptConfig } = await import("../lib/crypto");
  let targetProjectId: string | null = null;
  for (const row of githubIntegrations) {
    try {
      const cfg = decryptConfig(row.configEncrypted) as Record<string, unknown>;
      const alertCfg = cfg.alertConfig as { repoFilter?: string[] } | undefined;
      if (alertCfg?.repoFilter?.includes(DEMO_REPO)) {
        targetProjectId = row.projectId;
        break;
      }
    } catch {
      // skip
    }
  }

  if (!targetProjectId) {
    console.error(`❌ No project connected to ${DEMO_REPO}`);
    process.exit(1);
  }

  const [project] = await db
    .select({ id: schema.projects.id, name: schema.projects.name, userId: schema.projects.userId })
    .from(schema.projects)
    .where(eq(schema.projects.id, targetProjectId))
    .limit(1);

  console.log(`Project: ${project.name} (${project.id.slice(0, 8)}…)`);

  // Create alert + session.
  const [alert] = await db
    .insert(schema.alerts)
    .values({
      projectId: project.id,
      severity: "critical",
      title: ERROR_TITLE,
      body: ERROR_BODY,
      sourceIntegrations: ["sentry"],
      correlationData: { seed: true, e2eTest: true, pr: "pr3-apply-patch" },
    })
    .returning();

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

  console.log(`Session: https://app.inariwatch.com/admin/ai/session/${remSession.id}`);
  console.log();

  // Track tool usage specifically.
  const toolCalls = new Map<string, number>();
  const applyPatchResults: string[] = [];

  const { runRemediation } = await import("../lib/ai/remediate");
  const t0 = Date.now();
  let eventCount = 0;

  const emit = (event: string, data: unknown): void => {
    eventCount++;
    if (event === "container_tool" || event === "agentic_tool") {
      const d = data as { tool?: string; turn?: number; input?: unknown };
      const tool = d.tool ?? "unknown";
      toolCalls.set(tool, (toolCalls.get(tool) ?? 0) + 1);
      if (tool === "apply_patch") {
        const patch = (d.input as { patch?: string })?.patch ?? "";
        applyPatchResults.push(patch.slice(0, 300));
        console.log(`  [turn ${d.turn}] apply_patch (${patch.length} chars)`);
      } else {
        console.log(`  [turn ${d.turn}] ${tool}`);
      }
    } else if (event === "container_result" || event === "agentic_result") {
      // no-op — already logged the tool call
    } else if (event === "container_error" || event === "agentic_error") {
      console.log(`  ❌ ${event}:`, JSON.stringify(data).slice(0, 200));
    } else if (event === "done") {
      const d = data as { status?: string };
      console.log(`\n  ▶ done: ${d.status}`);
    } else if (event === "step") {
      const step = (data as { step?: { type?: string; message?: string } }).step;
      if (step && ["generate_fix", "await_ci", "retry", "max_retries", "push"].includes(step.type ?? "")) {
        console.log(`  [step] ${step.type}: ${(step.message ?? "").slice(0, 90)}`);
      }
    }
  };

  try {
    console.log(`▶ Running remediation…\n`);
    await runRemediation(remSession.id, emit);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✅ Pipeline finished in ${dt}s (${eventCount} events)`);
  } catch (err) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n❌ Pipeline threw after ${dt}s: ${err instanceof Error ? err.message : err}`);
  }

  // Summary from DB.
  const [finalSession] = await db
    .select()
    .from(schema.remediationSessions)
    .where(eq(schema.remediationSessions.id, remSession.id))
    .limit(1);

  const calls = await db
    .select({
      feature: schema.aiUsageLogs.feature,
      model: schema.aiUsageLogs.model,
      costUsd: schema.aiUsageLogs.costUsd,
      prompt: schema.aiUsageLogs.prompt,
    })
    .from(schema.aiUsageLogs)
    .where(eq(schema.aiUsageLogs.remediationSessionId, remSession.id));

  const totalCost = calls.reduce((s, c) => s + Number(c.costUsd ?? 0), 0);
  const gpt5 = calls.filter((c) => c.model.toLowerCase().startsWith("gpt-5")).length;

  console.log(`\n───── Tool usage ─────`);
  if (toolCalls.size === 0) {
    console.log(`  (no tool calls observed)`);
  }
  for (const [tool, count] of toolCalls) {
    const marker = tool === "apply_patch" ? "🎯" : "  ";
    console.log(`  ${marker} ${tool}: ${count}`);
  }

  const apCount = toolCalls.get("apply_patch") ?? 0;
  const wfCount = toolCalls.get("write_file") ?? 0;

  console.log(`\n───── PR #3 verdict ─────`);
  if (apCount > 0) {
    console.log(`✅ apply_patch was invoked ${apCount} time(s) — tool IS being selected.`);
    if (wfCount === 0) {
      console.log(`✅ write_file was NEVER used — agent preferred apply_patch as intended.`);
    } else {
      console.log(`⚠  write_file was also used ${wfCount} time(s) — mixed strategy.`);
    }
  } else if (wfCount > 0) {
    console.log(`❌ agent used write_file ${wfCount} time(s), NEVER apply_patch.`);
    console.log(`   Something is off with the tool description or prompt. Check:`);
    console.log(`   - Is the apply_patch tool registered? (web/lib/ai/container-agent.ts)`);
    console.log(`   - Is the prompt pointing at apply_patch? (step 4 should mention it)`);
  } else {
    console.log(`ℹ  Neither apply_patch nor write_file was called. Pipeline likely`);
    console.log(`   stopped before fix-generation — look at the session for the step.`);
  }

  // Prompt check for PR #2 overlay.
  const firstPrompt = calls.find((c) => c.model.toLowerCase().startsWith("gpt-5"))?.prompt ?? "";
  const hasImmutable = firstPrompt.includes("<immutable_rules");
  const hasGptOverlay = firstPrompt.includes("Autonomous Completion (GPT-specific)");
  const hasUntrusted = firstPrompt.includes("<untrusted source=");
  console.log(`\n───── PR #1 + PR #2 verdict ─────`);
  console.log(`  gpt-5.x calls: ${gpt5}  ${gpt5 > 0 ? "✅ Responses API path exercised" : "⚠  not exercised"}`);
  console.log(`  IMMUTABLE_RULES in prompt: ${hasImmutable ? "✅" : "❌"}`);
  console.log(`  GPT_OVERLAY in prompt:     ${hasGptOverlay ? "✅" : "❌"}`);
  console.log(`  <untrusted> wrap in ctx:   ${hasUntrusted ? "✅" : "❌"}`);

  console.log(`\n───── Session summary ─────`);
  console.log(`  Final status: ${finalSession.status}`);
  console.log(`  Total cost:   $${totalCost.toFixed(5)}`);
  console.log(`  AI calls:     ${calls.length}`);
  console.log(`  Session URL:  https://app.inariwatch.com/admin/ai/session/${remSession.id}`);
  console.log(`\nCleanup:`);
  console.log(`  DELETE FROM alerts WHERE id = '${alert.id}';`);

  if (applyPatchResults.length > 0) {
    console.log(`\n───── First apply_patch preview ─────`);
    console.log(applyPatchResults[0]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
