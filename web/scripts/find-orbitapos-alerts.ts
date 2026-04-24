import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, alerts, projects, remediationSessions } = await import("../lib/db");
  const { and, desc, eq, isNotNull } = await import("drizzle-orm");

  const [project] = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.slug, "orbitapos"))
    .limit(1);
  if (!project) {
    console.error("Project orbitapos not found");
    process.exit(1);
  }

  console.log(`Project: ${project.name} (${project.id})\n`);

  const rows = await db
    .select({
      alertId: alerts.id,
      title: alerts.title,
      severity: alerts.severity,
      createdAt: alerts.createdAt,
      remediationStatus: remediationSessions.status,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      remediationRepo: remediationSessions.repo,
      remediationBranch: remediationSessions.branch,
    })
    .from(alerts)
    .leftJoin(
      remediationSessions,
      eq(remediationSessions.alertId, alerts.id),
    )
    .where(eq(alerts.projectId, project.id))
    .orderBy(desc(alerts.createdAt))
    .limit(15);

  console.log(`15 most recent alerts in orbitapos:\n`);
  for (const r of rows) {
    const age = Math.round((Date.now() - r.createdAt.getTime()) / 60_000);
    const ageStr = age < 60 ? `${age}m` : age < 1440 ? `${Math.round(age / 60)}h` : `${Math.round(age / 1440)}d`;
    const rem = r.remediationStatus ? `${r.remediationStatus}${r.mergedCommitSha ? " ✓merged" : ""}` : "(no remediation)";
    console.log(`  ${r.alertId.slice(0, 8)}… [${r.severity.padEnd(8)}] ${ageStr.padStart(4)} ago`);
    console.log(`    "${r.title.slice(0, 75)}"`);
    console.log(`    remediation: ${rem}${r.remediationRepo ? ` · ${r.remediationRepo}@${r.remediationBranch}` : ""}`);
    if (r.remediationStatus === "completed" && r.mergedCommitSha) {
      console.log(`    → https://app.inariwatch.com/alerts/${r.alertId}  ← VALID PREVIEW CANDIDATE`);
    }
    console.log("");
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
