/**
 * Deep funnel diagnostic — second pass to identify the 1 project with autoRem=true,
 * source of the 15 sessions, and the 114 unclassified critical alerts.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { alerts, remediationSessions, projects } = await import("../lib/db");
  const { sql, gte, eq, desc, inArray } = await import("drizzle-orm");

  const SEVEN_DAYS = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // A) Which project has autoRemediate=true?
  console.log(`\n=== A) THE 1 PROJECT WITH autoRemediate=true ===`);
  const allProjects = await db
    .select({ id: projects.id, name: projects.name, autoMergeConfig: projects.autoMergeConfig, userId: projects.userId })
    .from(projects);
  for (const p of allProjects) {
    const cfg = (p.autoMergeConfig as { autoRemediate?: boolean; autoHeal?: boolean } | null) ?? {};
    if (cfg.autoRemediate) {
      console.log(`  ${p.name} (${p.id})`);
      console.log(`    autoRemediate: ${cfg.autoRemediate}, autoHeal: ${cfg.autoHeal}`);
    }
  }
  console.log(`\n  All projects + autoRemediate flag:`);
  for (const p of allProjects) {
    const cfg = (p.autoMergeConfig as { autoRemediate?: boolean } | null) ?? {};
    console.log(`    ${cfg.autoRemediate ? "YES" : "no "}   ${p.name} (${p.id.slice(0, 8)}…)`);
  }

  // B) The 15 sessions — who created them, which alerts
  console.log(`\n=== B) THE 15 SESSIONS (7d) ===`);
  const sessions = await db
    .select({
      id: remediationSessions.id,
      alertId: remediationSessions.alertId,
      projectId: remediationSessions.projectId,
      userId: remediationSessions.userId,
      status: remediationSessions.status,
      attempt: remediationSessions.attempt,
      repo: remediationSessions.repo,
      error: remediationSessions.error,
      prUrl: remediationSessions.prUrl,
      createdAt: remediationSessions.createdAt,
    })
    .from(remediationSessions)
    .where(gte(remediationSessions.createdAt, SEVEN_DAYS))
    .orderBy(desc(remediationSessions.createdAt));

  // Fetch alert titles
  const alertIds = sessions.map((s) => s.alertId).filter(Boolean);
  const alertMap = new Map(
    alertIds.length === 0 ? [] :
    (await db.select({ id: alerts.id, title: alerts.title, severity: alerts.severity, sourceIntegrations: alerts.sourceIntegrations, createdAt: alerts.createdAt }).from(alerts).where(inArray(alerts.id, alertIds))).map((a) => [a.id, a])
  );
  const projMap = new Map(allProjects.map((p) => [p.id, p.name]));

  console.log(`  status      attempt  repo                 pr?   created              alert_title`);
  for (const s of sessions) {
    const alert = alertMap.get(s.alertId);
    const title = (alert?.title ?? "(no alert)").slice(0, 50);
    const repo = (s.repo ?? "—").slice(0, 20).padEnd(20);
    const hasPr = s.prUrl ? "PR" : "  ";
    const date = s.createdAt?.toISOString().slice(0, 19) ?? "";
    console.log(`  ${(s.status ?? "null").padEnd(12)} ${String(s.attempt).padStart(2)}      ${repo}  ${hasPr}   ${date}  ${title}`);
    if (s.error) console.log(`    ERROR: ${s.error.slice(0, 120)}`);
  }

  // C) The 114 unclassified critical alerts — why null?
  console.log(`\n=== C) SAMPLE OF UNCLASSIFIED CRITICAL ALERTS (null triageClass) ===`);
  const unclassifiedCrit = await db
    .select({
      id: alerts.id,
      title: alerts.title,
      source: alerts.sourceIntegrations,
      body: alerts.body,
      correlation: alerts.correlationData,
      createdAt: alerts.createdAt,
      projectId: alerts.projectId,
    })
    .from(alerts)
    .where(sql`${alerts.createdAt} >= ${SEVEN_DAYS} AND ${alerts.severity} = 'critical' AND (${alerts.correlationData}->>'triageClass') IS NULL`)
    .orderBy(desc(alerts.createdAt))
    .limit(15);
  for (const a of unclassifiedCrit) {
    const proj = projMap.get(a.projectId) ?? "(unknown)";
    console.log(`  ${proj.padEnd(14)} src=${(a.source?.join(",") ?? "?").padEnd(10)} ${(a.title ?? "").slice(0, 80)}`);
  }

  // D) Critical alerts BY source (who's generating the critical volume?)
  console.log(`\n=== D) CRITICAL ALERTS (271) BY SOURCE ===`);
  const critAll = await db
    .select({
      source: alerts.sourceIntegrations,
      titlePrefix: sql<string>`SUBSTRING(${alerts.title} FOR 30)`,
      count: sql<number>`count(*)::int`,
    })
    .from(alerts)
    .where(sql`${alerts.createdAt} >= ${SEVEN_DAYS} AND ${alerts.severity} = 'critical'`)
    .groupBy(alerts.sourceIntegrations, sql`SUBSTRING(${alerts.title} FOR 30)`)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(20);
  console.log(`  count  source              title_prefix`);
  for (const row of critAll) {
    const src = (row.source?.join(",") ?? "?").slice(0, 18).padEnd(18);
    console.log(`  ${String(row.count).padStart(5)}  ${src}  ${row.titlePrefix ?? ""}`);
  }

  // E) Summary numbers for the report
  console.log(`\n=== E) FUNNEL SUMMARY ===`);
  const summary = {
    totalAlerts: 882,
    critical: 271,
    warning: 604,
    info: 7,
    fullRemClassified: 411,
    unclassified: 446,
    criticalEligibleAfterSkip: 54,
    criticalInAutoRemProject: 0,
    projectsWithAutoRem: 1,
    totalProjects: 13,
    sessionsCreated: sessions.length,
    sessionsCompleted: sessions.filter((s) => s.status === "completed").length,
    sessionsFailed: sessions.filter((s) => s.status === "failed").length,
    sessionsProposing: sessions.filter((s) => s.status === "proposing").length,
  };
  console.log(JSON.stringify(summary, null, 2));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
