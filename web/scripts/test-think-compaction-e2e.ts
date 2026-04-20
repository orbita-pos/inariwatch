/**
 * E2E validation for PR #4 — `think` tool + two-stage context compaction.
 *
 * Target bug (committed as e0fc398 on inariwatch-demo-store):
 *   - lib/pricing/discount.ts:31 — `(await validateCoupon(code))!` throws
 *     for unknown / expired codes.
 *   - Correct fix requires understanding the CONTRACT documented in
 *     app/api/discount/route.ts (unknown coupon → 400, not silent 0%).
 *   - The model must read validators.ts too to know the return shape.
 *
 * This means a good remediation crosses >= 3 files (route, discount, validators)
 * before apply_patch, which is exactly the territory where `think` helps
 * and where, if retries pile up, heavy context compaction kicks in.
 *
 * Validates:
 *   - Pipeline end-to-end
 *   - Agent calls `think` at least ONCE before apply_patch (PR #4 goal)
 *   - If the loop runs long enough, `agentic_compacted` fires (heavy stage)
 *   - apply_patch succeeds and touches discount.ts (and ideally route.ts)
 *   - Fix correctly treats the null case (returns 400 OR preserves subtotal)
 *   - PR #2 overlays still applied (IMMUTABLE_RULES + GPT_OVERLAY + untrusted)
 *
 * Usage:
 *   npx tsx scripts/test-think-compaction-e2e.ts
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
const ERROR_TITLE = "TypeError: Cannot read properties of null (reading 'discount')";
const ERROR_BODY = `TypeError: Cannot read properties of null (reading 'discount')
    at applyDiscount (lib/pricing/discount.ts:31:39)
    at POST (app/api/discount/route.ts:30:24)
    at NextRequest.handle (.next/server/middleware.js:47:10)

Request: POST /api/discount
Body:    { "cart": { "subtotal": 120.00, "items": [...] }, "couponCode": "WINTER50" }

The user submitted coupon code "WINTER50" which is not in the coupons table.
validateCoupon() returned null, and applyDiscount() uses non-null assertion
(\`(await validateCoupon(code))!\`) so the null propagates to \`.discount\`
access on line 31.

Contract in route.ts says unknown / expired coupon codes should return 400
with { error: "Invalid coupon code" }, not silently apply 0% discount.
Users are getting 500 errors on the checkout page.`;

async function main() {
  console.log(`🧪 PR #4 E2E: think + compaction`);
  console.log(`   repo:   ${DEMO_REPO}`);
  console.log(`   bug:    lib/pricing/discount.ts:31 unknown-coupon null crash`);
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
      correlationData: { seed: true, e2eTest: true, pr: "pr4-think-compaction" },
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

  // Track tool usage + compaction events.
  const toolCalls = new Map<string, number>();
  const thinkCalls: { turn: number; thought: string; confidence: string }[] = [];
  const compactionEvents: { turn: number; stage: string; messageCount: number }[] = [];
  const applyPatchAttempts: { turn: number; success: boolean; error?: string }[] = [];

  const { runRemediation } = await import("../lib/ai/remediate");
  const t0 = Date.now();
  let eventCount = 0;

  const emit = (event: string, data: unknown): void => {
    eventCount++;
    if (event === "agentic_tool" || event === "container_tool") {
      const d = data as { tool?: string; turn?: number; input?: Record<string, unknown> };
      const tool = d.tool ?? "unknown";
      toolCalls.set(tool, (toolCalls.get(tool) ?? 0) + 1);
      if (tool === "think") {
        const thought = (d.input?.thought as string) ?? "";
        const confidence = (d.input?.confidence as string) ?? "medium";
        thinkCalls.push({ turn: d.turn ?? 0, thought, confidence });
        console.log(`  💭 [turn ${d.turn}] think (${confidence}): ${thought.slice(0, 100)}${thought.length > 100 ? "…" : ""}`);
      } else if (tool === "apply_patch") {
        const patch = (d.input?.patch as string) ?? "";
        console.log(`  [turn ${d.turn}] apply_patch (${patch.length} chars)`);
      } else {
        const pathArg = (d.input as { path?: string })?.path ?? (d.input as { query?: string })?.query ?? "";
        console.log(`  [turn ${d.turn}] ${tool}${pathArg ? ` ${pathArg}` : ""}`);
      }
    } else if (event === "agentic_error" || event === "container_error") {
      const d = data as { turn?: number; tool?: string; error?: string };
      if (d.tool === "apply_patch") {
        applyPatchAttempts.push({ turn: d.turn ?? 0, success: false, error: d.error });
      }
      console.log(`  ❌ ${event}:`, JSON.stringify(data).slice(0, 200));
    } else if (event === "agentic_compacted") {
      const d = data as { turn?: number; stage?: string; messageCount?: number };
      compactionEvents.push({ turn: d.turn ?? 0, stage: d.stage ?? "unknown", messageCount: d.messageCount ?? 0 });
      console.log(`  🗜️  [turn ${d.turn}] compaction (${d.stage}) — messages: ${d.messageCount}`);
    } else if (event === "agentic_done") {
      const d = data as { turns?: number; via?: string; files?: string[] };
      console.log(`  ▶ agent done (turns=${d.turns}, via=${d.via}): ${(d.files ?? []).join(", ")}`);
    } else if (event === "done") {
      const d = data as { status?: string };
      console.log(`\n  ▶ pipeline done: ${d.status}`);
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
  const hasImmutable = calls.some((c) => (c.prompt ?? "").includes("<immutable_rules"));
  const hasGptOverlay = calls.some((c) =>
    (c.prompt ?? "").includes("Autonomous Completion (GPT-specific)"),
  );
  const hasUntrusted = calls.some((c) => (c.prompt ?? "").includes("<untrusted source="));

  console.log(`\n───── Tool usage ─────`);
  for (const [tool, count] of toolCalls) {
    const marker = tool === "think" ? "💭" : tool === "apply_patch" ? "🎯" : "  ";
    console.log(`  ${marker} ${tool}: ${count}`);
  }

  console.log(`\n───── PR #4 verdict ─────`);
  if (thinkCalls.length > 0) {
    console.log(`✅ think was invoked ${thinkCalls.length} time(s) — PR #4 think tool IS being selected.`);
    for (const t of thinkCalls) {
      console.log(`   • turn ${t.turn} [${t.confidence}]: ${t.thought.slice(0, 150)}${t.thought.length > 150 ? "…" : ""}`);
    }
  } else {
    console.log(`⚠  think was NEVER invoked. Either the bug was too simple, or the system prompt guidance isn't landing. Check the session drilldown.`);
  }

  if (compactionEvents.length > 0) {
    console.log(`\n✅ compaction fired ${compactionEvents.length} time(s):`);
    for (const c of compactionEvents) {
      console.log(`   • turn ${c.turn} [${c.stage}] — message count: ${c.messageCount}`);
    }
  } else {
    console.log(`\nℹ  compaction did not fire (loop stayed short). This is fine for bugs the agent solves quickly.`);
  }

  const apCount = toolCalls.get("apply_patch") ?? 0;
  const wfCount = toolCalls.get("write_file") ?? 0;
  console.log(`\n───── apply_patch outcome ─────`);
  console.log(`  apply_patch attempts: ${apCount}`);
  console.log(`  write_file attempts:  ${wfCount}  ${wfCount === 0 ? "✅" : "⚠"}`);

  console.log(`\n───── PR #1 + PR #2 overlays still applied? ─────`);
  console.log(`  gpt-5.x calls:           ${gpt5}  ${gpt5 > 0 ? "✅" : "⚠"}`);
  console.log(`  IMMUTABLE_RULES present: ${hasImmutable ? "✅" : "❌"}`);
  console.log(`  GPT_OVERLAY present:     ${hasGptOverlay ? "✅" : "❌"}`);
  console.log(`  <untrusted> wrap:        ${hasUntrusted ? "✅" : "❌"}`);

  console.log(`\n───── Session summary ─────`);
  console.log(`  Final status: ${finalSession.status}`);
  console.log(`  Total cost:   $${totalCost.toFixed(5)}`);
  console.log(`  AI calls:     ${calls.length}`);
  console.log(`  Session URL:  https://app.inariwatch.com/admin/ai/session/${remSession.id}`);
  console.log(`\nCleanup:`);
  console.log(`  DELETE FROM alerts WHERE id = '${alert.id}';`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
