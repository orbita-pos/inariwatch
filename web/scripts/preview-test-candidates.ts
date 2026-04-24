import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * List alerts that are good candidates to test Preview Fix on.
 * Scores by: has completed remediation, has merged_commit_sha, has
 * substrate recording with rrweb uiEvents.
 */
async function main() {
  const { db, alerts, remediationSessions, substrateRecordings, projects } =
    await import("../lib/db");
  const { and, desc, eq, isNotNull, sql } = await import("drizzle-orm");

  const candidates = await db
    .select({
      alertId: alerts.id,
      alertTitle: alerts.title,
      projectId: alerts.projectId,
      sessionId: alerts.sessionId,
      alertCreatedAt: alerts.createdAt,
      remediationId: remediationSessions.id,
      remediationStatus: remediationSessions.status,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      repo: remediationSessions.repo,
      branch: remediationSessions.branch,
      eapReceiptId: remediationSessions.eapReceiptId,
      previewSessionId: remediationSessions.previewSessionId,
    })
    .from(remediationSessions)
    .innerJoin(alerts, eq(alerts.id, remediationSessions.alertId))
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .where(
      and(
        eq(remediationSessions.status, "completed"),
        isNotNull(remediationSessions.mergedCommitSha),
      ),
    )
    .orderBy(desc(remediationSessions.createdAt))
    .limit(10);

  console.log(`Found ${candidates.length} alerts with completed + merged remediation:\n`);

  if (candidates.length === 0) {
    console.log("No testable alerts yet.");
    console.log("Need: an alert whose remediation reached status='completed' AND has merged_commit_sha.");
    console.log("\nQuick options to generate one:");
    console.log("  1. Trigger a real error in app.inariwatch.com + let autoRemediate run");
    console.log("  2. Manually run a remediation from dashboard 'Fix It' button on a critical alert");
    console.log("  3. Seed a fake one via scripts (faster for POC)");
    process.exit(0);
  }

  for (const c of candidates) {
    const hasRec = c.sessionId
      ? await db
          .select({ n: sql<number>`count(*)::int` })
          .from(substrateRecordings)
          .where(
            and(
              eq(substrateRecordings.sessionId, c.sessionId),
              isNotNull(substrateRecordings.uiEvents),
            ),
          )
          .then((r) => r[0].n > 0)
      : false;

    const hasRecByAlert = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(substrateRecordings)
      .where(
        and(
          eq(substrateRecordings.alertId, c.alertId),
          isNotNull(substrateRecordings.uiEvents),
        ),
      )
      .then((r) => r[0].n > 0);

    const hasSubstrate = hasRec || hasRecByAlert;
    const already = !!c.previewSessionId;

    const score =
      (hasSubstrate ? 2 : 0) + (c.eapReceiptId ? 1 : 0);
    const tier3Note = hasSubstrate
      ? "✓ Tier 3 will render (has rrweb)"
      : "✗ Tier 3 will skip (no substrate recording)";

    const ageMin = Math.round((Date.now() - c.alertCreatedAt.getTime()) / 60_000);
    const age = ageMin < 60 ? `${ageMin}m` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 1440)}d`;

    console.log(
      `  ${c.alertId.slice(0, 8)}… [score ${score}/3] ${age} ago`,
    );
    console.log(`    title: "${c.alertTitle.slice(0, 70)}${c.alertTitle.length > 70 ? "…" : ""}"`);
    console.log(`    repo:  ${c.repo ?? "(none)"}`);
    console.log(`    ${tier3Note}`);
    console.log(`    EAP: ${c.eapReceiptId ? c.eapReceiptId.slice(0, 16) + "…" : "(none)"}`);
    console.log(`    Preview already created: ${already ? "yes" : "no"}`);
    console.log(`    URL: https://app.inariwatch.com/alerts/${c.alertId}`);
    console.log("");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
