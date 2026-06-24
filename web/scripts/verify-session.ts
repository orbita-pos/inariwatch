import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "..", ".env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const sessionId = process.argv[2] ?? "fb28f73d-5575-4b93-8261-723ef941cba0";

async function main() {
  const calls = await db
    .select({
      feature: schema.aiUsageLogs.feature,
      model: schema.aiUsageLogs.model,
      costUsd: schema.aiUsageLogs.costUsd,
      prompt: schema.aiUsageLogs.prompt,
      response: schema.aiUsageLogs.response,
    })
    .from(schema.aiUsageLogs)
    .where(eq(schema.aiUsageLogs.remediationSessionId, sessionId))
    .orderBy(schema.aiUsageLogs.createdAt);

  const [session] = await db
    .select()
    .from(schema.remediationSessions)
    .where(eq(schema.remediationSessions.id, sessionId))
    .limit(1);

  let total = 0;
  let gpt5Count = 0;
  let applyPatchCount = 0;
  let writeFileCount = 0;
  let immutableRulesCount = 0;
  let gptOverlayCount = 0;
  let untrustedCount = 0;

  for (const c of calls) {
    total += Number(c.costUsd ?? 0);
    if (c.model.toLowerCase().startsWith("gpt-5")) gpt5Count++;
    const resp = c.response ?? "";
    if (resp.includes("apply_patch")) applyPatchCount++;
    if (resp.includes("write_file")) writeFileCount++;
    const prompt = c.prompt ?? "";
    if (prompt.includes("<immutable_rules")) immutableRulesCount++;
    if (prompt.includes("Autonomous Completion (GPT-specific)")) gptOverlayCount++;
    if (prompt.includes("<untrusted source=")) untrustedCount++;
  }

  console.log(`\n───── Session ${sessionId} ─────`);
  console.log(`  status:          ${session?.status}`);
  console.log(`  attempts:        ${session?.attempt}`);
  console.log(`  AI calls:        ${calls.length}`);
  console.log(`  total cost:      $${total.toFixed(5)}`);
  console.log(`  gpt-5.x calls:   ${gpt5Count}`);
  console.log(`  apply_patch in response: ${applyPatchCount}`);
  console.log(`  write_file in response:  ${writeFileCount}`);
  console.log(`\n───── PR #2 overlay coverage ─────`);
  console.log(`  IMMUTABLE_RULES in prompt: ${immutableRulesCount}/${calls.length}`);
  console.log(`  GPT_OVERLAY in prompt:     ${gptOverlayCount}/${calls.length}`);
  console.log(`  <untrusted> in prompt:     ${untrustedCount}/${calls.length}`);
}
main().catch(console.error);
