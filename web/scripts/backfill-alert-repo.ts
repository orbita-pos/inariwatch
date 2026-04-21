/**
 * Backfill `alerts.repo` for rows that pre-date migration 0068.
 *
 * Strategy (cheap, deterministic — no external API calls):
 *   - capture:    pull from correlationData.git.repo / .url / metadata.repo
 *   - github:     parse title like "CI failing on <repo>/<branch>" +
 *                 integration.config.owner → "owner/repo"
 *   - vercel:     parse title "… deploy <state> — <projectName>" + owner
 *                 → "owner/projectName" (best-effort; many Vercel projects
 *                 are named identically to their repo)
 *   - sentry:     no payload-level hints available in stored rows; skip
 *   - datadog:    body may contain "Tags: repo:a/b" — try that
 *   - others:     leave as NULL (the run-time legacy path in remediate.ts
 *                 still handles these; `projects.default_repo` is the
 *                 definitive fallback)
 *
 * Idempotent — only updates rows where repo IS NULL. Prints a summary at
 * the end.
 *
 * Usage: cd web && npx tsx scripts/backfill-alert-repo.ts [--dry-run]
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  normalizeRepo,
  resolveRepoFromCaptureEvent,
  resolveRepoFromDatadogTags,
} from "../lib/webhooks/resolve-repo";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const { db } = await import("../lib/db");
  const { alerts, projectIntegrations } = await import("../lib/db");
  const { decryptConfig } = await import("../lib/crypto");
  const { eq, and, isNull, sql } = await import("drizzle-orm");

  console.log(`\nBackfill alerts.repo ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`────────────────────────────────────────────────\n`);

  // Load GitHub integrations per project so we know the owner for each.
  const ghRows = await db
    .select({ projectId: projectIntegrations.projectId, configEncrypted: projectIntegrations.configEncrypted })
    .from(projectIntegrations)
    .where(and(eq(projectIntegrations.service, "github"), eq(projectIntegrations.isActive, true)));

  const ownerByProject = new Map<string, string>();
  for (const row of ghRows) {
    try {
      const cfg = decryptConfig(row.configEncrypted);
      const owner = (cfg.owner as string | undefined) ?? "";
      if (owner) ownerByProject.set(row.projectId, owner);
    } catch {
      // Integration with corrupt config — skip silently
    }
  }

  // Pull ALL rows missing repo (no date cutoff — migration applies to entire history).
  const rows = await db
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      title: alerts.title,
      body: alerts.body,
      sourceIntegrations: alerts.sourceIntegrations,
      correlationData: alerts.correlationData,
    })
    .from(alerts)
    .where(isNull(alerts.repo));

  console.log(`Rows with repo=NULL: ${rows.length}`);

  let updated = 0;
  const bySource = new Map<string, { total: number; resolved: number }>();
  const sampleResolved: { id: string; source: string; repo: string; title: string }[] = [];
  const sampleUnresolved: { id: string; source: string; title: string }[] = [];

  for (const row of rows) {
    const sources = row.sourceIntegrations ?? [];
    const src = sources[0] ?? "unknown";
    const bucket = bySource.get(src) ?? { total: 0, resolved: 0 };
    bucket.total++;
    bySource.set(src, bucket);

    let repo: string | null = null;

    if (sources.includes("capture") && row.correlationData) {
      const cd = row.correlationData as {
        git?: { repo?: unknown; url?: unknown } | null;
        metadata?: { repo?: unknown } | null;
      };
      repo = resolveRepoFromCaptureEvent({ git: cd.git, metadata: cd.metadata });
    }

    if (!repo && sources.includes("github")) {
      // Title pattern: "CI failing on <name>/<branch>" or "Workflow … failed on <name>/<branch>"
      const m = row.title?.match(/\bon\s+([A-Za-z0-9._-]+)\/[A-Za-z0-9._-]+/);
      const owner = ownerByProject.get(row.projectId);
      if (m && owner) repo = normalizeRepo(`${owner}/${m[1]}`);
    }

    if (!repo && sources.includes("vercel")) {
      // Title pattern: "Production deploy failed — <projectName>"
      const m = row.title?.match(/—\s+([A-Za-z0-9._-]+)/);
      const owner = ownerByProject.get(row.projectId);
      if (m && owner) repo = normalizeRepo(`${owner}/${m[1]}`);
    }

    if (!repo && sources.includes("datadog") && row.body) {
      // "Tags: repo:a/b,env:prod"
      const tagLine = row.body.match(/Tags:\s*([^\n]+)/i);
      if (tagLine) {
        const tags = tagLine[1].split(",").map((t) => t.trim());
        repo = resolveRepoFromDatadogTags(tags);
      }
    }

    if (repo) {
      bucket.resolved++;
      if (sampleResolved.length < 10) {
        sampleResolved.push({ id: row.id.slice(0, 8), source: src, repo, title: (row.title ?? "").slice(0, 60) });
      }
      if (!DRY_RUN) {
        await db.update(alerts).set({ repo }).where(eq(alerts.id, row.id));
      }
      updated++;
    } else if (sampleUnresolved.length < 10) {
      sampleUnresolved.push({ id: row.id.slice(0, 8), source: src, title: (row.title ?? "").slice(0, 60) });
    }
  }

  console.log(`\nBy source:`);
  console.log(`  source          total   resolved  unresolved`);
  for (const [src, b] of Array.from(bySource.entries()).sort((a, b) => b[1].total - a[1].total)) {
    const u = b.total - b.resolved;
    console.log(`  ${src.padEnd(14)}  ${String(b.total).padStart(6)}  ${String(b.resolved).padStart(8)}  ${String(u).padStart(10)}`);
  }

  console.log(`\nTotal ${DRY_RUN ? "would update" : "updated"}: ${updated} / ${rows.length}`);

  if (sampleResolved.length > 0) {
    console.log(`\nSample resolved:`);
    for (const s of sampleResolved) console.log(`  ${s.id}  ${s.source.padEnd(10)}  ${s.repo.padEnd(30)}  ${s.title}`);
  }
  if (sampleUnresolved.length > 0) {
    console.log(`\nSample unresolved (project.default_repo will cover these at remediation time):`);
    for (const s of sampleUnresolved) console.log(`  ${s.id}  ${s.source.padEnd(10)}  ${s.title}`);
  }

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
