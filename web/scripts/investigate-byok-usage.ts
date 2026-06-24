/**
 * Investigate BYOK usage for the past 48 hours.
 *
 * Usage: cd web && npx tsx scripts/investigate-byok-usage.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const TWO_DAYS_AGO = new Date(Date.now() - 48 * 60 * 60 * 1000);
const ONE_DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);

// Rough cost estimates (per call) — calibrated to InariWatch defaults.
const COST_PER_AUTO_ANALYZE = 0.003; // Haiku, ~600 tokens avg
const COST_PER_REMEDIATION = 0.25;   // Sonnet, agentic loop, ~50k tokens total avg
const COST_PER_CONTAINER_AGENT = 0.40; // Container agent, more turns
const COST_PER_ASK_INARI = 0.01;     // Chat, ~2k tokens
const COST_PER_SECURITY_SCAN = 0.02; // AI review, ~4k tokens
const COST_PER_RISK_ASSESS = 0.02;   // Risk assessment

function money(n: number) {
  return `$${n.toFixed(4)}`;
}

async function main() {
  const { db } = await import("../lib/db");
  const { alerts, remediationSessions } = await import("../lib/db/schema");
  const { sql, gte, and, desc } = await import("drizzle-orm");

  console.log("\n=== BYOK Usage Investigation ===");
  console.log(`Looking at last 48 hours (since ${TWO_DAYS_AGO.toISOString()})\n`);

  // ── 1. Alert counts ───────────────────────────────────────────
  console.log("--- ALERTS ---");
  const alertsToday = await db
    .select({
      source: alerts.sourceIntegrations,
      count: sql<number>`count(*)::int`,
      withAiReasoning: sql<number>`count(*) filter (where ${alerts.aiReasoning} is not null)::int`,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, TWO_DAYS_AGO))
    .groupBy(alerts.sourceIntegrations);

  let totalAlerts = 0;
  let totalAnalyzed = 0;
  for (const row of alertsToday) {
    const src = Array.isArray(row.source) ? row.source.join(",") : String(row.source);
    console.log(`  source=${src.padEnd(20)} count=${String(row.count).padStart(5)}  aiReasoning populated=${row.withAiReasoning}`);
    totalAlerts += row.count;
    totalAnalyzed += row.withAiReasoning;
  }
  console.log(`  TOTAL alerts last 48h: ${totalAlerts}`);
  console.log(`  TOTAL with aiReasoning (auto-analyzed): ${totalAnalyzed}`);
  console.log(`  Estimated auto-analyze cost: ${money(totalAnalyzed * COST_PER_AUTO_ANALYZE)}`);

  // Alerts by severity + agent source
  console.log("\n--- AGENT ALERTS BY SEVERITY ---");
  const agentAlerts = await db
    .select({
      severity: alerts.severity,
      alertType: alerts.alertType,
      count: sql<number>`count(*)::int`,
    })
    .from(alerts)
    .where(
      and(
        gte(alerts.createdAt, TWO_DAYS_AGO),
        sql`${alerts.sourceIntegrations} @> ARRAY['agent']::text[]`
      )
    )
    .groupBy(alerts.severity, alerts.alertType);

  for (const row of agentAlerts) {
    console.log(`  ${row.severity.padEnd(10)} ${row.alertType.padEnd(12)} count=${row.count}`);
  }

  // ── 2. Remediation sessions ──────────────────────────────────
  console.log("\n--- REMEDIATION SESSIONS ---");
  const remediationRaw = await db.execute(sql`
    SELECT
      id,
      alert_id,
      status,
      attempt,
      created_at,
      checkpoint_phase
    FROM remediation_sessions
    WHERE created_at >= ${TWO_DAYS_AGO.toISOString()}
    ORDER BY created_at DESC
  `);
  const remediations = remediationRaw.rows as Array<{
    id: string;
    alert_id: string;
    status: string;
    attempt: number;
    created_at: Date;
    checkpoint_phase: string | null;
  }>;

  console.log(`  Total remediation sessions (last 48h): ${remediations.length}`);

  const byStatus: Record<string, number> = {};
  let totalRemediationCost = 0;

  for (const r of remediations) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    totalRemediationCost += COST_PER_REMEDIATION * (r.attempt || 1);
  }

  console.log("  By status:", byStatus);
  console.log(`  Estimated remediation cost: ${money(totalRemediationCost)}`);

  // ── 3. Last 10 sessions in detail ────────────────────────────
  console.log("\n--- LAST 10 REMEDIATION SESSIONS ---");
  for (const r of remediations.slice(0, 10)) {
    const createdAt = new Date(r.created_at).toISOString();
    console.log(`  ${createdAt} status=${r.status.padEnd(20)} attempt=${r.attempt} alert=${r.alert_id.slice(0, 8)}`);
  }

  // ── 4. Total estimate ────────────────────────────────────────
  console.log("\n=== TOTAL ESTIMATE (last 48h) ===");
  const autoAnalyzeCost = totalAnalyzed * COST_PER_AUTO_ANALYZE;
  const totalEstimate = autoAnalyzeCost + totalRemediationCost;
  console.log(`  Auto-analyze (${totalAnalyzed} calls):  ${money(autoAnalyzeCost)}`);
  console.log(`  Remediations (${remediations.length} sessions): ${money(totalRemediationCost)}`);
  console.log(`  ────────────────────────────────`);
  console.log(`  TOTAL:                              ${money(totalEstimate)}`);

  console.log("\nNote: These are rough estimates. Real cost depends on:");
  console.log("  - Actual token counts per call");
  console.log("  - Model used (Opus vs Sonnet vs Haiku)");
  console.log("  - Number of retries on failed remediations");
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
