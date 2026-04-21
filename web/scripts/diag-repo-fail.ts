/**
 * Investigate the "Could not determine repository from alert" failure.
 * Pulls the specific session + alert + project integration state to
 * identify whether it's a config gap, data gap, or code bug.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { alerts, remediationSessions, projects, projectIntegrations } = await import("../lib/db");
  const { eq, and, sql, gte } = await import("drizzle-orm");

  const SEVEN_DAYS = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Find the failed session with that exact error
  const failed = await db
    .select({
      id: remediationSessions.id,
      alertId: remediationSessions.alertId,
      projectId: remediationSessions.projectId,
      error: remediationSessions.error,
      createdAt: remediationSessions.createdAt,
      steps: remediationSessions.steps,
    })
    .from(remediationSessions)
    .where(and(
      gte(remediationSessions.createdAt, SEVEN_DAYS),
      eq(remediationSessions.status, "failed"),
      sql`${remediationSessions.error} LIKE 'Could not determine repository%'`,
    ));

  console.log(`=== FAILED SESSIONS WITH "Could not determine repository" ===`);
  console.log(`Count: ${failed.length}\n`);

  for (const s of failed) {
    console.log(`── Session ${s.id}`);
    console.log(`   created: ${s.createdAt?.toISOString()}`);
    console.log(`   error:   ${s.error}`);

    // Pull the alert
    const [alert] = await db.select().from(alerts).where(eq(alerts.id, s.alertId)).limit(1);
    if (!alert) {
      console.log(`   alert: NOT FOUND (deleted?)`);
      continue;
    }
    console.log(`\n   ALERT:`);
    console.log(`     id:     ${alert.id}`);
    console.log(`     title:  ${alert.title}`);
    console.log(`     source: ${alert.sourceIntegrations?.join(",")}`);
    console.log(`     severity: ${alert.severity}`);
    console.log(`     body (first 500):`);
    console.log(`     ${(alert.body ?? "(empty)").slice(0, 500)}`);
    console.log(`     correlationData keys: ${alert.correlationData ? Object.keys(alert.correlationData as object).join(", ") : "(none)"}`);

    // Pull project + integrations
    const [proj] = await db.select().from(projects).where(eq(projects.id, s.projectId)).limit(1);
    console.log(`\n   PROJECT:`);
    console.log(`     name: ${proj?.name}`);
    console.log(`     id:   ${proj?.id}`);

    const integs = await db.select().from(projectIntegrations).where(eq(projectIntegrations.projectId, s.projectId));
    console.log(`\n   INTEGRATIONS (${integs.length}):`);
    for (const i of integs) {
      console.log(`     ${i.service} (active=${i.isActive})`);
      // Don't decrypt — but show non-secret shape
      try {
        const rawCfg = i.configEncrypted as unknown;
        const shape = typeof rawCfg === "object" && rawCfg !== null
          ? `encrypted (${Object.keys(rawCfg as object).join(",")})`
          : typeof rawCfg;
        console.log(`       config shape: ${shape}`);
      } catch {
        console.log(`       config: (unreadable)`);
      }
    }

    // Walk extractRepo logic manually on the title
    const title = alert.title ?? "";
    const onMatch = title.match(/\bon\s+([a-zA-Z0-9_.-]+)\/[a-zA-Z0-9_.-]+/);
    const dashMatch = title.match(/—\s+([a-zA-Z0-9_.-]+)/);
    console.log(`\n   extractRepo(title) dry-run:`);
    console.log(`     regex "on X/Y":  ${onMatch ? onMatch[1] : "(no match)"}`);
    console.log(`     regex "— X":     ${dashMatch ? dashMatch[1] : "(no match)"}`);
    console.log(`     → extractRepo returns: ${onMatch?.[1] ?? dashMatch?.[1] ?? "null"}`);

    console.log(`\n${"─".repeat(80)}\n`);
  }

  // Bonus: how many current alerts would hit this failure mode if remediated?
  const currCritical = await db
    .select({
      id: alerts.id,
      title: alerts.title,
      source: alerts.sourceIntegrations,
      projectId: alerts.projectId,
    })
    .from(alerts)
    .where(sql`${alerts.createdAt} >= ${SEVEN_DAYS} AND ${alerts.severity} = 'critical' AND NOT (${alerts.sourceIntegrations} && ARRAY['agent']::text[])`);

  let wouldMiss = 0;
  let wouldHit = 0;
  for (const a of currCritical) {
    const t = a.title ?? "";
    const onMatch = t.match(/\bon\s+([a-zA-Z0-9_.-]+)\/[a-zA-Z0-9_.-]+/);
    const dashMatch = t.match(/—\s+([a-zA-Z0-9_.-]+)/);
    if (onMatch || dashMatch) wouldHit++;
    else wouldMiss++;
  }
  console.log(`=== REPO-EXTRACTION COVERAGE (current 7d critical, non-agent alerts) ===`);
  console.log(`Total:                ${currCritical.length}`);
  console.log(`extractRepo succeeds: ${wouldHit}`);
  console.log(`extractRepo returns null (relies on fallbacks): ${wouldMiss}`);

  // Breakdown by source for the null ones
  const nullBySource = new Map<string, number>();
  for (const a of currCritical) {
    const t = a.title ?? "";
    if (t.match(/\bon\s+([a-zA-Z0-9_.-]+)\/[a-zA-Z0-9_.-]+/) || t.match(/—\s+([a-zA-Z0-9_.-]+)/)) continue;
    const src = (a.source?.join(",") ?? "?");
    nullBySource.set(src, (nullBySource.get(src) ?? 0) + 1);
  }
  console.log(`\nNull-extract by source:`);
  for (const [src, c] of nullBySource) console.log(`  ${src.padEnd(15)} ${c}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
