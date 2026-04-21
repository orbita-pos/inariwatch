/**
 * Manually create and run a remediation session for a given alert id.
 * Useful when autoRemediate didn't fire for one reason or another.
 *
 * Usage: cd web && npx tsx scripts/trigger-remediation.ts <alertId1> [alertId2 ...]
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const alertIds = process.argv.slice(2);
  if (alertIds.length === 0) { console.error("pass one or more alert ids"); process.exit(1); }

  const { db } = await import("../lib/db");
  const { alerts, projects, remediationSessions } = await import("../lib/db");
  const { eq } = await import("drizzle-orm");
  const { runRemediation } = await import("../lib/ai/remediate");

  for (const alertId of alertIds) {
    console.log(`\n── ${alertId}`);
    const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
    if (!alert) { console.error(`  alert not found`); continue; }

    const [proj] = await db.select({ userId: projects.userId }).from(projects).where(eq(projects.id, alert.projectId)).limit(1);
    if (!proj) { console.error(`  project not found`); continue; }

    const [session] = await db
      .insert(remediationSessions)
      .values({
        alertId: alert.id,
        projectId: alert.projectId,
        userId: proj.userId,
        status: "analyzing",
        attempt: 1,
        maxAttempts: 3,
        steps: [],
      })
      .returning();
    console.log(`  session ${session.id.slice(0, 8)} created`);

    try {
      await runRemediation(session.id, (stage, data) => {
        console.log(`    [${stage}] ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 80)}`);
      });
    } catch (err) {
      console.error(`  threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    const [final] = await db
      .select({ status: remediationSessions.status, error: remediationSessions.error, prUrl: remediationSessions.prUrl })
      .from(remediationSessions)
      .where(eq(remediationSessions.id, session.id))
      .limit(1);
    console.log(`  final: status=${final?.status} pr=${final?.prUrl ?? "—"}`);
    if (final?.error) console.log(`  error: ${final.error.slice(0, 200)}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
