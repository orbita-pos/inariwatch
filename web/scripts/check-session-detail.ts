import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const sessionPrefix = process.argv[2];
  const { db } = await import("../lib/db");
  const { remediationSessions } = await import("../lib/db");
  const { sql, desc } = await import("drizzle-orm");

  const rows = await db
    .select()
    .from(remediationSessions)
    .where(sql`${remediationSessions.id}::text LIKE ${sessionPrefix + "%"}`)
    .orderBy(desc(remediationSessions.createdAt))
    .limit(1);

  if (rows.length === 0) { console.log("no match"); process.exit(0); }
  const r = rows[0];
  console.log(`Session: ${r.id}`);
  console.log(`  status:          ${r.status}`);
  console.log(`  attempt:         ${r.attempt}/${r.maxAttempts}`);
  console.log(`  repo:            ${r.repo ?? "(none)"}`);
  console.log(`  branch:          ${r.branch ?? "(none)"}`);
  console.log(`  baseBranch:      ${r.baseBranch ?? "(none)"}`);
  console.log(`  prUrl:           ${r.prUrl ?? "(none)"}`);
  console.log(`  prNumber:        ${r.prNumber ?? "(none)"}`);
  console.log(`  confidenceScore: ${r.confidenceScore ?? "(none)"}`);
  console.log(`  mergeStrategy:   ${r.mergeStrategy ?? "(none)"}`);
  console.log(`  mergedCommitSha: ${r.mergedCommitSha ?? "(none)"}`);
  console.log(`  error:           ${(r.error ?? "").slice(0, 200)}`);
  console.log(`  createdAt:       ${r.createdAt?.toISOString()}`);
  console.log(`  checkpointPhase: ${r.checkpointPhase ?? "(none)"}`);

  const steps = (r.steps ?? []) as Array<Record<string, unknown>>;
  console.log(`  steps (${steps.length}):`);
  for (const s of steps) {
    const msg = typeof s.message === "string" ? s.message.slice(0, 100) : "";
    console.log(`    [${s.phase ?? "?"}]${s.status ? ` (${s.status})` : ""} ${msg}`);
  }

  const fileChanges = r.fileChanges as Array<{ path?: string; content?: string }> | null;
  if (fileChanges && fileChanges.length > 0) {
    console.log(`\n  fileChanges (${fileChanges.length}):`);
    for (const fc of fileChanges) {
      console.log(`    ── ${fc.path} (${fc.content?.length ?? 0} chars)`);
      if (fc.content) {
        const preview = fc.content.slice(0, 400).split("\n").map((l) => `      ${l}`).join("\n");
        console.log(preview);
      }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
