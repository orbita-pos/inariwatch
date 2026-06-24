import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const alertId = process.argv[2];
  if (!alertId) { console.error("Usage: npx tsx scripts/alert-to-project.ts <alertId>"); process.exit(1); }

  const { db, alerts, projects, remediationSessions, projectIntegrations } = await import("../lib/db");
  const { eq, desc } = await import("drizzle-orm");

  const [a] = await db
    .select({ id: alerts.id, projectId: alerts.projectId, title: alerts.title })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);
  if (!a) { console.log("alert not found"); process.exit(0); }

  const [p] = await db.select().from(projects).where(eq(projects.id, a.projectId)).limit(1);
  console.log(`alert:    ${a.id.slice(0,8)}…  "${a.title.slice(0,70)}"`);
  console.log(`project:  ${p?.slug ?? "(unknown)"}  (${a.projectId.slice(0,8)}…)`);

  const [rem] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.alertId, alertId))
    .orderBy(desc(remediationSessions.createdAt))
    .limit(1);
  if (rem) {
    console.log(`remediation: status=${rem.status}  repo=${rem.repo ?? "(none)"}  branch=${rem.branch ?? "(none)"}`);
  }

  const integs = await db
    .select({ id: projectIntegrations.id, service: projectIntegrations.service, isActive: projectIntegrations.isActive, lastErrorAt: projectIntegrations.lastErrorAt })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.projectId, a.projectId));
  console.log(`integrations on ${p?.slug}:`);
  for (const i of integs) console.log(`  ${i.service.padEnd(10)} active=${i.isActive}  lastErrorAt=${i.lastErrorAt?.toISOString() ?? "(none)"}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
