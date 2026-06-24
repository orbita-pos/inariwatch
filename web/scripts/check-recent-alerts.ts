import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { alerts, remediationSessions } = await import("../lib/db");
  const { gte, desc, eq } = await import("drizzle-orm");

  const since = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await db
    .select({
      id: alerts.id,
      title: alerts.title,
      severity: alerts.severity,
      sourceIntegrations: alerts.sourceIntegrations,
      repo: alerts.repo,
      fingerprint: alerts.fingerprint,
      createdAt: alerts.createdAt,
      projectId: alerts.projectId,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, since))
    .orderBy(desc(alerts.createdAt))
    .limit(20);

  console.log(`Alerts in last 15 min: ${rows.length}`);
  for (const a of rows) {
    const [sess] = await db
      .select({ id: remediationSessions.id, status: remediationSessions.status })
      .from(remediationSessions)
      .where(eq(remediationSessions.alertId, a.id))
      .limit(1);
    console.log(
      `  ${a.id.slice(0, 8)}  ${(a.severity ?? "").padEnd(9)}  src=${(a.sourceIntegrations?.join(",") ?? "?").padEnd(10)}  repo=${(a.repo ?? "—").padEnd(30)}  session=${sess ? sess.status : "NONE"}  ${(a.title ?? "").slice(0, 60)}`
    );
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
