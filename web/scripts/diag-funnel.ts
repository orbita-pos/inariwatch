/**
 * Funnel diagnostic — why 411 full_remediation classifications → 2 sessions?
 *
 * Traces alert → classifier → auto-remediate gate → session creation, showing
 * exactly where the funnel loses volume.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { alerts, remediationSessions, projects } = await import("../lib/db");
  const { sql, gte, eq } = await import("drizzle-orm");

  const SEVEN_DAYS = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  console.log(`\n=== FUNNEL DIAGNOSTIC (last 7 days from ${SEVEN_DAYS.toISOString()}) ===\n`);

  // 1. Total alerts + severity breakdown
  const alertsBySeverity = await db
    .select({
      severity: alerts.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, SEVEN_DAYS))
    .groupBy(alerts.severity);

  const totalAlerts = alertsBySeverity.reduce((s, r) => s + r.count, 0);
  console.log(`TOTAL ALERTS (7d): ${totalAlerts}`);
  for (const row of alertsBySeverity) {
    console.log(`  ${(row.severity ?? "null").padEnd(10)} ${row.count}`);
  }

  // 2. Triage class distribution (from correlationData.triageClass)
  const byTriage = await db
    .select({
      triageClass: sql<string>`COALESCE(${alerts.correlationData}->>'triageClass', '(null)')`,
      count: sql<number>`count(*)::int`,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, SEVEN_DAYS))
    .groupBy(sql`COALESCE(${alerts.correlationData}->>'triageClass', '(null)')`);

  console.log(`\nTRIAGE CLASS DISTRIBUTION:`);
  for (const row of byTriage) {
    const pct = totalAlerts > 0 ? ((row.count / totalAlerts) * 100).toFixed(1) : "0.0";
    console.log(`  ${row.triageClass.padEnd(18)} ${String(row.count).padStart(5)}  (${pct}%)`);
  }

  // 3. Cross-tab: severity × triageClass
  const crossTab = await db
    .select({
      severity: alerts.severity,
      triageClass: sql<string>`COALESCE(${alerts.correlationData}->>'triageClass', '(null)')`,
      count: sql<number>`count(*)::int`,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, SEVEN_DAYS))
    .groupBy(alerts.severity, sql`COALESCE(${alerts.correlationData}->>'triageClass', '(null)')`);

  console.log(`\nSEVERITY × TRIAGE CLASS:`);
  console.log(`  severity    triageClass         count`);
  for (const row of crossTab) {
    console.log(`  ${(row.severity ?? "null").padEnd(10)}  ${row.triageClass.padEnd(18)}  ${row.count}`);
  }

  // 4. Critical alerts — the only ones eligible for auto-remediate
  const critRows = await db
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      title: alerts.title,
      createdAt: alerts.createdAt,
      sourceIntegrations: alerts.sourceIntegrations,
    })
    .from(alerts)
    .where(sql`${alerts.createdAt} >= ${SEVEN_DAYS} AND ${alerts.severity} = 'critical'`);

  const criticalCount = critRows.length;
  console.log(`\nCRITICAL ALERTS (eligible for auto-remediate): ${criticalCount}`);

  // Filter out the alerts that shared.ts SKIPS:
  // isRevertAlert (title starts with "[Auto-Revert]") + isAgentAlert (sourceIntegrations includes "agent")
  const eligibleCrit = critRows.filter((a) => {
    const isRevert = (a.title ?? "").startsWith("[Auto-Revert]");
    const isAgent = Array.isArray(a.sourceIntegrations) && a.sourceIntegrations.includes("agent");
    return !isRevert && !isAgent;
  });
  console.log(`  After skip filters (revert/agent): ${eligibleCrit.length}`);

  // 5. For eligible critical alerts, check if their project has autoRemediate: true
  const projIds = Array.from(new Set(eligibleCrit.map((a) => a.projectId)));
  const { inArray } = await import("drizzle-orm");
  const projRows = projIds.length
    ? await db
        .select({ id: projects.id, name: projects.name, autoMergeConfig: projects.autoMergeConfig })
        .from(projects)
        .where(inArray(projects.id, projIds))
    : [];

  const projMap = new Map(
    projRows.map((p) => {
      const cfg = (p.autoMergeConfig as { autoRemediate?: boolean } | null) ?? {};
      return [p.id, { name: p.name, autoRemediate: cfg.autoRemediate === true }];
    })
  );

  let withAutoRem = 0;
  let withoutAutoRem = 0;
  const perProject = new Map<string, { name: string; auto: boolean; count: number }>();
  for (const a of eligibleCrit) {
    const p = projMap.get(a.projectId);
    if (p?.autoRemediate) withAutoRem++;
    else withoutAutoRem++;
    const key = a.projectId;
    const prev = perProject.get(key) ?? { name: p?.name ?? "(unknown)", auto: p?.autoRemediate ?? false, count: 0 };
    prev.count++;
    perProject.set(key, prev);
  }
  console.log(`\n  Eligible critical in projects WITH autoRemediate=true: ${withAutoRem}`);
  console.log(`  Eligible critical in projects WITHOUT autoRemediate: ${withoutAutoRem}`);

  console.log(`\nPER PROJECT BREAKDOWN (critical alerts):`);
  console.log(`  autoRem  count  project`);
  const sorted = Array.from(perProject.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [pid, info] of sorted.slice(0, 20)) {
    console.log(`  ${info.auto ? "YES    " : "no     "}  ${String(info.count).padStart(5)}  ${info.name} (${pid.slice(0, 8)}…)`);
  }

  // 6. Total projects — how many have autoRemediate: true?
  const allProjects = await db
    .select({ id: projects.id, autoMergeConfig: projects.autoMergeConfig })
    .from(projects);
  const projectsWithAuto = allProjects.filter((p) => {
    const cfg = (p.autoMergeConfig as { autoRemediate?: boolean } | null) ?? {};
    return cfg.autoRemediate === true;
  }).length;
  console.log(`\nPROJECTS: total=${allProjects.length}, with autoRemediate=true: ${projectsWithAuto}`);

  // 7. Remediation sessions — total, by status
  const sessionsByStatus = await db
    .select({
      status: remediationSessions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(remediationSessions)
    .where(gte(remediationSessions.createdAt, SEVEN_DAYS))
    .groupBy(remediationSessions.status);

  const totalSessions = sessionsByStatus.reduce((s, r) => s + r.count, 0);
  console.log(`\nREMEDIATION SESSIONS (7d): ${totalSessions}`);
  for (const row of sessionsByStatus) {
    console.log(`  ${(row.status ?? "null").padEnd(22)} ${row.count}`);
  }

  // 8. Sessions with zero turns — failed before burning tokens
  const zeroTurnSessions = await db
    .select({
      status: remediationSessions.status,
      error: remediationSessions.error,
    })
    .from(remediationSessions)
    .where(gte(remediationSessions.createdAt, SEVEN_DAYS));

  console.log(`\nSESSION OUTCOME DETAIL:`);
  for (const row of zeroTurnSessions) {
    console.log(`  ${(row.status ?? "null").padEnd(22)} err=${(row.error ?? "").slice(0, 80)}`);
  }

  // 9. THE GAP: critical alerts that SHOULD have auto-triggered but have no session
  const eligibleWithAuto = eligibleCrit.filter((a) => projMap.get(a.projectId)?.autoRemediate === true);
  const alertIdsWithSession = new Set(
    eligibleWithAuto.length === 0
      ? []
      : (
          await db
            .select({ alertId: remediationSessions.alertId })
            .from(remediationSessions)
            .where(inArray(remediationSessions.alertId, eligibleWithAuto.map((a) => a.id)))
        ).map((r) => r.alertId)
  );

  const missed = eligibleWithAuto.filter((a) => !alertIdsWithSession.has(a.id));
  console.log(`\n=== THE GAP ===`);
  console.log(`Critical alerts in autoRemediate=true projects: ${eligibleWithAuto.length}`);
  console.log(`Of those, WITH session created:    ${eligibleWithAuto.length - missed.length}`);
  console.log(`Of those, WITHOUT session (MISSED): ${missed.length}`);
  if (missed.length > 0) {
    console.log(`\nFIRST 10 MISSED:`);
    for (const a of missed.slice(0, 10)) {
      console.log(`  ${a.id.slice(0, 8)}… ${a.createdAt?.toISOString() ?? ""} ${(a.title ?? "").slice(0, 70)}`);
    }
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
