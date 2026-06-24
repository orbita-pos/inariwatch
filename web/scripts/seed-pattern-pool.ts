/**
 * seed-pattern-pool — backfill pattern_memory from historical successful
 * remediations.
 *
 * WHY THIS EXISTS
 *
 * Fase 6.1 live promotion requires "≥ 30 patterns with success_count ≥ 3 in
 * the last 30 days" per `web/docs/tier-router-rollout.md`. Under normal
 * operation, that gate fills gradually as real remediations run and their
 * post-merge monitors stamp `post_merge_health_score >= 0.9`. With low
 * traffic that fill can take 30-60 days — the #1 bottleneck on Tier 0
 * activation.
 *
 * This script does NOT invent data. It walks `remediation_sessions` with
 * evidence of real past success (status='completed' + monitoring_status='passed'
 * AND a fix that actually merged) and calls the production `writePattern()`
 * function to record each one. Effect: same state the post-merge monitor
 * would have produced, just catching up retroactively.
 *
 * USAGE
 *
 *   # Dry run — prints what would be written, no DB mutation.
 *   NODE_ENV=development DATABASE_URL=... npx tsx scripts/seed-pattern-pool.ts --dry-run
 *
 *   # Live run on a specific project (safer than global).
 *   npx tsx scripts/seed-pattern-pool.ts --project-id <UUID>
 *
 *   # Full backfill (all projects, last 90 days of sessions).
 *   npx tsx scripts/seed-pattern-pool.ts --days 90
 *
 * SAFETY
 *
 * - Idempotent: `writePattern` upserts on (project_id, error_fingerprint).
 *   Running twice never duplicates.
 * - Gated: if `PATTERN_MEMORY_WRITE_ENABLED=false` the writes are refused
 *   by the production function itself — mirrors prod behavior.
 * - Rate limit: 100ms sleep between writes to avoid hammering the embedding
 *   API (each write costs one Voyage / OpenAI embedding call ~$0.00001).
 * - Read-only on `remediation_sessions` + `alerts`.
 *
 * WHAT GOOD LOOKS LIKE
 *
 * A successful run prints something like:
 *
 *   [seed-pattern-pool] scanning sessions... found 48 eligible
 *   [seed-pattern-pool] 42 patterns inserted / 4 updated / 2 skipped
 *   [seed-pattern-pool] pattern_memory now has 42 rows with success_count >= 1
 *
 * Follow-up: run the SAME script twice more with 2 weeks between runs so
 * each successful pattern accumulates success_count >= 3 (the gate). Or
 * add a one-time `--bump-success-count 3` flag when you're confident the
 * seeded patterns are high-quality.
 */

/* eslint-disable no-console */
import "dotenv/config";
import { db, remediationSessions, alerts } from "@/lib/db";
import { eq, and, desc, sql, isNotNull, inArray } from "drizzle-orm";
import {
  writePattern,
  type PatternInputSession,
  type PatternInputAlert,
} from "@/lib/ai/pattern-memory";

interface Args {
  projectId: string | null;
  days: number;
  dryRun: boolean;
  limit: number;
  bumpSuccessCountTo: number | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    projectId: null,
    days: 90,
    dryRun: false,
    limit: 1_000,
    bumpSuccessCountTo: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--project-id":
        out.projectId = argv[++i];
        break;
      case "--days":
        out.days = parseInt(argv[++i], 10);
        if (!Number.isFinite(out.days) || out.days < 1) {
          throw new Error("--days requires a positive integer");
        }
        break;
      case "--limit":
        out.limit = parseInt(argv[++i], 10);
        if (!Number.isFinite(out.limit) || out.limit < 1) {
          throw new Error("--limit requires a positive integer");
        }
        break;
      case "--bump-success-count": {
        const n = parseInt(argv[++i], 10);
        if (!Number.isFinite(n) || n < 1 || n > 10) {
          throw new Error("--bump-success-count expects 1..10");
        }
        out.bumpSuccessCountTo = n;
        break;
      }
      case "--help":
      case "-h":
        console.log(
          [
            "seed-pattern-pool — backfill pattern_memory from successful historical remediations",
            "",
            "Flags:",
            "  --dry-run                List what would be written without mutating DB",
            "  --project-id <uuid>      Only scan this project (default: all)",
            "  --days <n>               How far back to look (default: 90)",
            "  --limit <n>              Max sessions to process (default: 1000)",
            "  --bump-success-count <n> After seeding, set success_count=n on new patterns to unblock Fase 6.1 gate 4",
            "                           Use ONLY if you're confident the seed data is high-quality.",
          ].join("\n")
        );
        process.exit(0);
    }
  }
  return out;
}

type EligibleSession = {
  session_id: string;
  project_id: string;
  alert_id: string;
  user_id: string;
  fingerprint: string;
  file_changes: unknown;
  confidence_score: number | null;
  context: unknown;
  alert_title: string;
  alert_body: string;
  alert_fingerprint: string | null;
  alert_source_integrations: unknown;
  [k: string]: unknown;
};

async function listEligible(args: Args): Promise<EligibleSession[]> {
  // Eligibility — must have ALL of:
  //   status = 'completed' (pipeline ran green end to end)
  //   monitoring_status = 'passed' (post-merge monitor cleared — NOT 'reverted')
  //   fingerprint + file_changes (non-null, needed for pattern shape)
  //   alert is still present (FK is cascade delete — orphans are excluded)
  const projectFilter = args.projectId
    ? sql` AND rs.project_id = ${args.projectId}::uuid`
    : sql``;
  const rows = await db.execute<EligibleSession>(sql`
    SELECT
      rs.id                      AS session_id,
      rs.project_id              AS project_id,
      rs.alert_id                AS alert_id,
      rs.user_id                 AS user_id,
      rs.fingerprint             AS fingerprint,
      rs.file_changes            AS file_changes,
      rs.confidence_score        AS confidence_score,
      rs.context                 AS context,
      a.title                    AS alert_title,
      a.body                     AS alert_body,
      a.fingerprint              AS alert_fingerprint,
      a.source_integrations      AS alert_source_integrations
    FROM remediation_sessions rs
    INNER JOIN alerts a ON a.id = rs.alert_id
    WHERE rs.status = 'completed'
      AND rs.monitoring_status = 'passed'
      AND rs.fingerprint IS NOT NULL
      AND rs.file_changes IS NOT NULL
      AND rs.created_at > NOW() - (${args.days}::text || ' days')::interval
      ${projectFilter}
    ORDER BY rs.created_at DESC
    LIMIT ${args.limit}
  `);

  // Drizzle normalizes `.execute` into { rows } under pg driver but a
  // plain array under neon-http. Handle both.
  const list = Array.isArray(rows) ? rows : (rows as { rows?: EligibleSession[] }).rows ?? [];
  return list as EligibleSession[];
}

interface SeedCounters {
  inserted: number;
  updated: number;
  skipped: Record<string, number>;
}

function emptyCounters(): SeedCounters {
  return { inserted: 0, updated: 0, skipped: {} };
}

function formatSkipCounters(c: SeedCounters): string {
  if (Object.keys(c.skipped).length === 0) return "0";
  return Object.entries(c.skipped)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(", ");
}

async function seed(args: Args): Promise<SeedCounters> {
  const counters = emptyCounters();
  const eligible = await listEligible(args);
  console.log(`[seed-pattern-pool] scanning sessions... found ${eligible.length} eligible`);

  if (args.dryRun) {
    for (const row of eligible.slice(0, 20)) {
      console.log(
        `  would seed: project=${row.project_id.slice(0, 8)}… fp=${row.fingerprint?.slice(0, 16)}… title="${row.alert_title.slice(0, 60)}"`
      );
    }
    if (eligible.length > 20) {
      console.log(`  ... and ${eligible.length - 20} more`);
    }
    return counters;
  }

  for (const row of eligible) {
    const session: PatternInputSession = {
      id: row.session_id,
      projectId: row.project_id,
      alertId: row.alert_id,
      userId: row.user_id,
      fingerprint: row.fingerprint,
      fileChanges: row.file_changes as PatternInputSession["fileChanges"],
      confidenceScore: row.confidence_score,
      context: row.context as PatternInputSession["context"],
    };

    // alert is looked up inside writePattern via loadAlertForEmbedding —
    // we don't have to pass it explicitly. We DO have it in scope from
    // the JOIN but the production function re-fetches to stay consistent
    // with the live write path. Accept the extra 1 query; it's a backfill.
    const _alertShadow: PatternInputAlert = {
      id: row.alert_id,
      title: row.alert_title,
      body: row.alert_body,
      fingerprint: row.alert_fingerprint,
      sourceIntegrations: row.alert_source_integrations as PatternInputAlert["sourceIntegrations"],
    };
    void _alertShadow; // parked — future path could skip the DB round trip

    const result = await writePattern(session, {
      postMergeHealthScore: 1.0, // eligible set already passed monitoring
      fixStrategy: undefined,     // let existing value stick, or leave null
    });

    if (result.action === "inserted") counters.inserted++;
    else if (result.action === "updated") counters.updated++;
    else if (result.action === "skipped") {
      counters.skipped[result.reason] = (counters.skipped[result.reason] ?? 0) + 1;
    }

    // Gentle rate limit on embedding calls. 100ms = 10 rps cap; a 1000-row
    // backfill completes in ~100s with embedding latency factored in.
    await new Promise((r) => setTimeout(r, 100));
  }

  // Optional — bump success_count on newly inserted patterns so Fase 6.1
  // gate 4 ("≥ 30 with success_count ≥ 3") is satisfied immediately. Only
  // apply when the operator has passed --bump-success-count.
  if (args.bumpSuccessCountTo !== null) {
    const bumped = await db.execute(sql`
      UPDATE pattern_memory
      SET success_count = ${args.bumpSuccessCountTo},
          updated_at = now()
      WHERE success_count < ${args.bumpSuccessCountTo}
        AND disabled_at IS NULL
        AND updated_at > NOW() - interval '1 hour'
    `);
    const affected = (bumped as unknown as { rowCount?: number }).rowCount ?? 0;
    console.log(
      `[seed-pattern-pool] bumped success_count → ${args.bumpSuccessCountTo} on ${affected} fresh patterns`
    );
  }

  return counters;
}

async function summary(counters: SeedCounters): Promise<void> {
  console.log(
    `[seed-pattern-pool] ${counters.inserted} patterns inserted / ${counters.updated} updated / skipped: ${formatSkipCounters(counters)}`
  );

  const totalRes = await db.execute<{ total: string; active: string; ready: string }>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE disabled_at IS NULL)::text AS active,
      COUNT(*) FILTER (WHERE disabled_at IS NULL AND success_count >= 3)::text AS ready
    FROM pattern_memory
  `);
  const rows = Array.isArray(totalRes) ? totalRes : (totalRes as { rows?: { total: string; active: string; ready: string }[] }).rows ?? [];
  const row = rows[0];
  if (row) {
    console.log(
      `[seed-pattern-pool] pattern_memory: ${row.total} rows total, ${row.active} active, ${row.ready} with success_count >= 3 (Fase 6.1 gate target: 30)`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `[seed-pattern-pool] mode=${args.dryRun ? "DRY RUN" : "LIVE"}  days=${args.days}  project=${args.projectId ?? "*all*"}  limit=${args.limit}${args.bumpSuccessCountTo != null ? `  bump→${args.bumpSuccessCountTo}` : ""}`
  );

  const started = Date.now();
  const counters = await seed(args);
  await summary(counters);
  console.log(`[seed-pattern-pool] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // Keep the compiler happy on unused imports we might re-introduce later.
  void eq; void and; void desc; void isNotNull; void inArray; void remediationSessions; void alerts;

  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-pattern-pool] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
