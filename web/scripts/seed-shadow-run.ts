/**
 * Phase 3.1 — synthetic shadow-run seeder.
 *
 * Walks the Phase 0.5 baseline corpus (50 representative queries) and
 * dispatches each through `searchCode()` so the shadow harness writes a
 * real `code_intel_shadow_log` row for it. Lets the /admin/ops widget
 * (Phase 1.7) and the cutover dashboard (Phase 3.3) light up on day 1
 * without waiting for organic dashboard traffic.
 *
 * Pre-conditions:
 *   - DATABASE_URL points at the env you want to seed (usually Neon).
 *   - CODE_INTEL_V2 must equal "shadow" (script asserts this — fail-fast
 *     so an operator can't accidentally write rows in the wrong mode).
 *   - The target project has at least one `code_repositories` row in
 *     status='ready' for v2 to have something to query against. v1 runs
 *     regardless.
 *
 * Usage:
 *   cd web
 *   CODE_INTEL_V2=shadow npx tsx scripts/seed-shadow-run.ts \
 *     --project <projectId> [--limit 10] [--dry-run]
 *
 * Cleanup is intentionally NOT provided — these rows are short-lived and
 * the cutover script aggregates over a 24h window. Drop them by hand if
 * needed (`DELETE FROM code_intel_shadow_log WHERE project_id=$1`).
 */

import { config } from "dotenv";
import path from "node:path";
import { readFileSync } from "node:fs";

config({ path: path.join(__dirname, "../.env.local") });

const DEFAULT_LIMIT = 25;
const CORPUS_PATH = path.join(
  __dirname,
  "..",
  "lib",
  "code-intelligence",
  "__tests__",
  "v1-baseline-corpus.json",
);

interface Args {
  projectId: string;
  limit: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const i = argv.findIndex((a) => a === flag);
    if (i < 0) return undefined;
    return argv[i + 1];
  };
  const projectId = valueOf("--project") ?? valueOf("--projectId") ?? "";
  const limit = Number.parseInt(valueOf("--limit") ?? `${DEFAULT_LIMIT}`, 10);
  const dryRun = argv.includes("--dry-run");
  if (!projectId) {
    console.error("Error: --project <projectId> is required.");
    process.exit(1);
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`Error: --limit must be a positive integer (got '${limit}').`);
    process.exit(1);
  }
  return { projectId, limit, dryRun };
}

interface Corpus {
  categories: Record<string, string[]>;
}

function loadQueries(limit: number): { query: string; category: string }[] {
  const raw = readFileSync(CORPUS_PATH, "utf8");
  const parsed = JSON.parse(raw) as Corpus;
  const out: { query: string; category: string }[] = [];
  for (const [category, queries] of Object.entries(parsed.categories)) {
    for (const q of queries) out.push({ category, query: q });
  }
  return out.slice(0, limit);
}

async function main() {
  const args = parseArgs();

  const engine = (process.env.CODE_INTEL_V2 ?? "off").toLowerCase().trim();
  if (engine !== "shadow") {
    console.error(
      `Error: CODE_INTEL_V2 must be 'shadow' for this script to seed comparisons (current='${engine}').`,
    );
    console.error("       Set CODE_INTEL_V2=shadow before invoking — refusing to write rows in the wrong mode.");
    process.exit(1);
  }

  const queries = loadQueries(args.limit);
  console.log(`\nPhase 3.1 — shadow seeder`);
  console.log(`────────────────────────────────────────────────`);
  console.log(`Project:    ${args.projectId}`);
  console.log(`Queries:    ${queries.length} (corpus capped at --limit=${args.limit})`);
  console.log(`Engine:     CODE_INTEL_V2=${engine}`);
  console.log(`Mode:       ${args.dryRun ? "DRY RUN (no calls)" : "REAL CALLS"}`);
  console.log(``);

  if (args.dryRun) {
    for (const q of queries) console.log(`  [dry] ${q.category.padEnd(15)} ${q.query}`);
    return;
  }

  // Lazy-import the service so .env is loaded before db.ts evaluates
  // process.env.DATABASE_URL. Same pattern as backfill-alert-repo.ts.
  const { searchCode } = await import("../lib/services/code-intelligence.service");

  let ok = 0;
  let fail = 0;
  const t0 = Date.now();

  for (const q of queries) {
    const start = Date.now();
    try {
      const results = await searchCode({
        projectId: args.projectId,
        query: q.query,
        limit: 10,
      });
      const ms = Date.now() - start;
      ok++;
      console.log(
        `  ✓ ${q.category.padEnd(15)} ${q.query.padEnd(50).slice(0, 50)} → ${results.length} hits in ${ms}ms`,
      );
    } catch (err) {
      fail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${q.category.padEnd(15)} ${q.query.padEnd(50).slice(0, 50)} → ${msg.slice(0, 80)}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(``);
  console.log(`────────────────────────────────────────────────`);
  console.log(`Done in ${elapsed}s — ok=${ok}, fail=${fail}, total=${queries.length}`);
  console.log(`Inspect rows: SELECT count(*), v2_timed_out FROM code_intel_shadow_log WHERE project_id='${args.projectId}' GROUP BY v2_timed_out;`);
  console.log(``);
}

main().catch((err) => {
  console.error("\nseed-shadow-run failed:", err);
  process.exit(1);
});
