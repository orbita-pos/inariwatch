/**
 * Replay historical critical alerts against the new pipeline to generate
 * a real baseline dataset without waiting for fresh traffic.
 *
 * Strategy:
 *   1. Pick critical, non-agent alerts from the last N days
 *   2. Skip alerts that already have a remediation session
 *   3. Skip alerts whose project has no active GitHub integration
 *   4. For each survivor: INSERT remediation_session + runRemediation()
 *   5. Cap concurrency so we don't saturate the AI API / GitHub API
 *
 * Budget note: platform AI budget is $100/day with a $1 reserve per
 * session. 50 sessions × $0.25 worst-case = $12.50. Fine.
 *
 * Usage:
 *   cd web && npx tsx scripts/replay-historical-alerts.ts --days=7 --limit=50           # dry-run
 *   cd web && npx tsx scripts/replay-historical-alerts.ts --days=7 --limit=50 --apply   # execute
 *   cd web && npx tsx scripts/replay-historical-alerts.ts --days=30 --limit=100 --apply --concurrency=3
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const args = process.argv.slice(2);
  const days = parseInt(args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "7", 10);
  const limit = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "50", 10);
  const concurrency = parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "5", 10);
  const apply = args.includes("--apply");

  const { db } = await import("../lib/db");
  const { alerts, remediationSessions, projects, projectIntegrations } = await import("../lib/db");
  const { sql, gte, eq, and, desc, inArray, isNull, isNotNull } = await import("drizzle-orm");

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(`\n=== Replay Historical Alerts ===`);
  console.log(`Window:        last ${days} days (since ${cutoff.toISOString()})`);
  console.log(`Limit:         ${limit}`);
  console.log(`Concurrency:   ${concurrency}`);
  console.log(`Mode:          ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(``);

  // 1. Projects with an active GitHub integration — required for remediation.
  const ghProjects = await db
    .select({ projectId: projectIntegrations.projectId })
    .from(projectIntegrations)
    .where(and(eq(projectIntegrations.service, "github"), eq(projectIntegrations.isActive, true)));
  const ghProjectIds = Array.from(new Set(ghProjects.map((r) => r.projectId)));
  console.log(`Projects with GitHub:    ${ghProjectIds.length}`);

  if (ghProjectIds.length === 0) {
    console.log(`No projects have an active GitHub integration. Nothing to replay.`);
    process.exit(0);
  }

  // 2. Candidate alerts: critical, non-agent, in a GH-connected project,
  //    after the cutoff, not resolved, and with no existing session.
  //    We also exclude [Auto-Revert] titles (prevents loops), mirroring
  //    the shared.ts skip filters.
  const rawCandidates = await db
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      title: alerts.title,
      body: alerts.body,
      sourceIntegrations: alerts.sourceIntegrations,
      repo: alerts.repo,
      fingerprint: alerts.fingerprint,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .where(
      and(
        eq(alerts.severity, "critical"),
        eq(alerts.isResolved, false),
        gte(alerts.createdAt, cutoff),
        inArray(alerts.projectId, ghProjectIds),
        sql`NOT (${alerts.sourceIntegrations} && ARRAY['agent']::text[])`,
        sql`${alerts.title} NOT LIKE '[Auto-Revert]%'`,
      )
    )
    .orderBy(desc(alerts.createdAt));

  // Deduplicate by fingerprint + project — same bug shouldn't burn
  // tokens N times. Fall back to (project+title) when fingerprint is null.
  const seenKey = new Set<string>();
  const candidates = rawCandidates.filter((a) => {
    const key = `${a.projectId}:${a.fingerprint ?? `title:${a.title}`}`;
    if (seenKey.has(key)) return false;
    seenKey.add(key);
    return true;
  });

  console.log(`Raw candidates:          ${rawCandidates.length}`);
  console.log(`After fingerprint dedup: ${candidates.length}`);

  // 3. Skip alerts that already have a session (completed, failed,
  //    proposing — anything).
  const candIds = candidates.map((a) => a.id);
  const existingSessions = candIds.length === 0 ? [] : await db
    .select({ alertId: remediationSessions.alertId })
    .from(remediationSessions)
    .where(inArray(remediationSessions.alertId, candIds));
  const hasSession = new Set(existingSessions.map((s) => s.alertId));
  const fresh = candidates.filter((a) => !hasSession.has(a.id)).slice(0, limit);

  console.log(`Already had sessions:    ${candidates.length - candidates.filter((a) => !hasSession.has(a.id)).length}`);
  console.log(`To replay (capped):      ${fresh.length}`);
  console.log(``);

  if (fresh.length === 0) {
    console.log(`Nothing to do.`);
    process.exit(0);
  }

  // 4. Project metadata (name, userId) for the insert
  const projRows = await db
    .select({ id: projects.id, name: projects.name, userId: projects.userId, defaultRepo: projects.defaultRepo })
    .from(projects)
    .where(inArray(projects.id, Array.from(new Set(fresh.map((a) => a.projectId)))));
  const projMap = new Map(projRows.map((p) => [p.id, p]));

  // 5. Preview
  console.log(`Preview (top 10):`);
  console.log(`  source         project          repo                           title`);
  for (const a of fresh.slice(0, 10)) {
    const p = projMap.get(a.projectId);
    const repo = a.repo ?? p?.defaultRepo ?? "(legacy fallback)";
    console.log(`  ${(a.sourceIntegrations?.[0] ?? "?").padEnd(13)}  ${(p?.name ?? "?").padEnd(15)}  ${repo.padEnd(30)}  ${(a.title ?? "").slice(0, 55)}`);
  }
  if (fresh.length > 10) console.log(`  ... + ${fresh.length - 10} more`);
  console.log(``);

  if (!apply) {
    console.log(`Dry-run only. Re-run with --apply to execute.`);
    process.exit(0);
  }

  // 6. Execute — kick off sessions with bounded concurrency. Each
  //    runRemediation() is long-running (~30s-2min), so we batch by
  //    awaiting Promise.all on chunks of `concurrency` size.
  const { runRemediation } = await import("../lib/ai/remediate");

  const outcomes: { alertId: string; sessionId?: string; status: string; error?: string }[] = [];
  let done = 0;
  const started = Date.now();

  for (let i = 0; i < fresh.length; i += concurrency) {
    const batch = fresh.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (alert) => {
        const proj = projMap.get(alert.projectId);
        if (!proj) return { alertId: alert.id, status: "skipped", error: "project not found" };

        try {
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

          // Run synchronously so we can capture the outcome. No-op emit.
          await runRemediation(session.id, () => {});

          // Re-read session to capture final status
          const [final] = await db
            .select({ status: remediationSessions.status, error: remediationSessions.error })
            .from(remediationSessions)
            .where(eq(remediationSessions.id, session.id))
            .limit(1);

          return {
            alertId: alert.id,
            sessionId: session.id,
            status: final?.status ?? "unknown",
            error: final?.error ?? undefined,
          };
        } catch (err) {
          return {
            alertId: alert.id,
            status: "threw",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
    outcomes.push(...batchResults);
    done += batch.length;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[${done}/${fresh.length}] batch done (${elapsed}s elapsed)`);
  }

  // 7. Summary
  const byStatus = new Map<string, number>();
  for (const o of outcomes) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);

  console.log(`\n=== Summary ===`);
  console.log(`Total replayed:     ${outcomes.length}`);
  for (const [status, n] of Array.from(byStatus.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(20)} ${n}`);
  }

  const failed = outcomes.filter((o) => o.status === "failed" || o.status === "threw");
  if (failed.length > 0) {
    console.log(`\nFailures (first 10):`);
    for (const o of failed.slice(0, 10)) {
      console.log(`  ${o.alertId.slice(0, 8)}  ${o.status}  ${(o.error ?? "").slice(0, 100)}`);
    }
  }

  console.log(`\nTotal elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`Check /admin/ai for session details.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
