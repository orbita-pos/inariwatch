/**
 * Extract a Braintrust-ready dataset from the remediation sessions
 * produced during our replay + bug-injection runs.
 *
 * Output format (one JSONL record per session):
 *   {
 *     input:  { alert_title, alert_body, alert_source, alert_repo, alert_fingerprint }
 *     expected: null | { fix_pattern }
 *     output: { diagnosis, fix_files, self_review_score, confidence, outcome, pr_url }
 *     metadata: { session_id, project, attempts, error, duration_s, turns }
 *   }
 *
 * Sessions that never produced a fix are still recorded — they're the
 * "system knew when not to touch it" signal that a golden dataset
 * needs.
 *
 * Usage: cd web && npx tsx scripts/extract-golden-dataset.ts [--minutes=240] > dataset.jsonl
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "fs";

// Curated bug registry — used for expected-fix-pattern lookup by the
// fixture path embedded in the alert body. Keep in sync with
// `inject-bugs-to-demo.ts`. If you add a bug there, mirror it here
// (or better: extract to a shared JSON file in a later refactor).
const CURATED_BUGS: Record<string, { id: string; pattern: RegExp; description: string }> = {
  "bug-01-null-deref.js": {
    id: "null-deref-user-profile",
    pattern: /\?\.|user\?.profile|typeof.*profile|profile\s*&&|if\s*\(.*profile/,
    description: "Null deref — should use optional chaining or guard",
  },
  "bug-02-foreach-undefined.js": {
    id: "undefined-foreach",
    // Accepts `data ?? []`, `data || []`, `data && data.forEach`, `Array.isArray(data)`,
    // `if (data)` guards, or optional chaining `data?.forEach`.
    pattern: /data\s*\?\.|\?\?\s*\[\]|data\s*&&|\|\|\s*\[\]|Array\.isArray|if\s*\(.*data/,
    description: "forEach on undefined — should guard or default to []",
  },
  "bug-03-missing-await.js": {
    id: "missing-await",
    pattern: /await\s+db\.insert/,
    description: "Missing await on async DB call",
  },
  "bug-04-div-zero.js": {
    id: "division-by-zero",
    pattern: /count\s*===?\s*0|count\s*>\s*0|if\s*\(.*length|\?\s*.*:.*0|\|\|\s*0/,
    description: "Division by zero",
  },
  "bug-05-off-by-one.js": {
    id: "off-by-one-loop",
    pattern: /i\s*<\s*arr\.length/,
    description: "Off-by-one loop",
  },
  "bug-06-json-parse.js": {
    id: "json-parse-unhandled",
    pattern: /try\s*\{|catch\s*\(|\.catch\s*\(/,
    description: "Unhandled JSON.parse",
  },
  "bug-07-sql-injection.js": {
    id: "sql-injection-concat",
    pattern: /\$\d|\?\s*$|parameterize|prepared|db\.query\s*\([^,]+,\s*\[/,
    description: "SQL injection",
  },
  "bug-08-unhandled-fetch.js": {
    id: "missing-error-handler",
    pattern: /res\.ok|res\.status|if\s*\(.*res|throw|catch/,
    description: "Unhandled fetch failure",
  },
  "bug-09-loose-equality.js": {
    id: "type-coercion",
    pattern: /===\s*0|typeof.*number|Number\.isFinite|!Number\.isNaN/,
    description: "Loose equality",
  },
  "bug-10-race-condition.js": {
    id: "race-condition-counter",
    pattern: /\+\+counter|counter\s*\+=|atomic|lock|mutex|Atomics/,
    description: "Race condition",
  },
};

function curatedBugFromBody(body: string | null | undefined): { id: string; pattern: RegExp; description: string } | null {
  if (!body) return null;
  for (const [filename, bug] of Object.entries(CURATED_BUGS)) {
    if (body.includes(filename)) return bug;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const minutes = parseInt(args.find((a) => a.startsWith("--minutes="))?.split("=")[1] ?? "240", 10);
  const outPath = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "golden-dataset.jsonl";

  const { db } = await import("../lib/db");
  const { remediationSessions, alerts, projects } = await import("../lib/db");
  const { gte, desc, eq } = await import("drizzle-orm");

  const since = new Date(Date.now() - minutes * 60 * 1000);
  const sessions = await db
    .select()
    .from(remediationSessions)
    .where(gte(remediationSessions.createdAt, since))
    .orderBy(desc(remediationSessions.createdAt));

  const records: string[] = [];
  for (const s of sessions) {
    const [alert] = await db.select().from(alerts).where(eq(alerts.id, s.alertId)).limit(1);
    const [proj] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, s.projectId)).limit(1);

    if (!alert) continue;

    const correlation = (alert.correlationData ?? {}) as Record<string, unknown>;
    const bugMetadata = (correlation.metadata ?? {}) as Record<string, unknown>;
    // Two sources of expected pattern:
    //   1) correlationData.metadata.expectedFixPattern (if webhook preserved it — currently doesn't)
    //   2) curated registry lookup by filename in alert body (reliable)
    const fromMeta = typeof bugMetadata.expectedFixPattern === "string" ? bugMetadata.expectedFixPattern : null;
    const curatedBug = curatedBugFromBody(alert.body);
    const expectedPattern = fromMeta ?? (curatedBug ? curatedBug.pattern.source : null);
    const bugId = (typeof bugMetadata.bugId === "string" ? bugMetadata.bugId : null) ?? curatedBug?.id ?? null;

    const steps = (s.steps ?? []) as Array<{ message?: string; phase?: string; status?: string }>;
    const diagnosis = steps.find((x) => (x.message ?? "").startsWith("Diagnosis"))?.message ?? null;
    const fixMessage = steps.find((x) => (x.message ?? "").startsWith("Fix"))?.message ?? null;
    const selfReview = steps.find((x) => (x.message ?? "").includes("Self-review"))?.message ?? null;
    const selfReviewScore = selfReview ? (selfReview.match(/Self-review:\s*(\d+)/)?.[1] ?? null) : null;

    const fileChanges = (s.fileChanges ?? []) as Array<{ path?: string; content?: string }>;

    // Check fix pattern match (if expected)
    let fixMatchesExpected: boolean | null = null;
    if (expectedPattern && fileChanges.length > 0) {
      try {
        const pattern = new RegExp(expectedPattern);
        const joined = fileChanges.map((f) => f.content ?? "").join("\n");
        fixMatchesExpected = pattern.test(joined);
      } catch {
        fixMatchesExpected = null;
      }
    }

    const durationS = s.createdAt ? Math.round((Date.now() - s.createdAt.getTime()) / 1000) : null;

    const record = {
      input: {
        alert_title: alert.title,
        alert_body: (alert.body ?? "").slice(0, 1500),
        alert_source: alert.sourceIntegrations ?? [],
        alert_repo: alert.repo ?? null,
        alert_fingerprint: alert.fingerprint ?? null,
      },
      expected: expectedPattern ? {
        fix_pattern: expectedPattern,
        pattern_matched: fixMatchesExpected,
        bug_id: bugId,
      } : null,
      output: {
        diagnosis_excerpt: diagnosis?.slice(0, 500) ?? null,
        fix_summary: fixMessage?.slice(0, 500) ?? null,
        fix_files: fileChanges.map((f) => ({ path: f.path, content_preview: (f.content ?? "").slice(0, 800) })),
        self_review_score: selfReviewScore ? parseInt(selfReviewScore, 10) : null,
        confidence: s.confidenceScore ?? null,
        outcome: s.status,
        pr_url: s.prUrl ?? null,
        merge_strategy: s.mergeStrategy ?? null,
      },
      metadata: {
        session_id: s.id,
        project: proj?.name ?? null,
        attempts: `${s.attempt}/${s.maxAttempts}`,
        error: s.error ?? null,
        step_count: steps.length,
        created_at: s.createdAt?.toISOString(),
        duration_s: durationS,
      },
    };
    records.push(JSON.stringify(record));
  }

  writeFileSync(outPath, records.join("\n"), "utf-8");

  // Summary
  const outcomeCounts = new Map<string, number>();
  const patternMatches = { matched: 0, unmatched: 0, unknown: 0 };
  const sample = records.slice(0, 3).map((r) => JSON.parse(r));
  for (const line of records) {
    const r = JSON.parse(line) as { output: { outcome: string }; expected: { pattern_matched: boolean | null } | null };
    outcomeCounts.set(r.output.outcome, (outcomeCounts.get(r.output.outcome) ?? 0) + 1);
    if (r.expected) {
      if (r.expected.pattern_matched === true) patternMatches.matched++;
      else if (r.expected.pattern_matched === false) patternMatches.unmatched++;
      else patternMatches.unknown++;
    }
  }

  console.log(`\n=== Golden Dataset Extracted ===`);
  console.log(`Records:    ${records.length}`);
  console.log(`Output:     ${outPath}`);
  console.log(``);
  console.log(`Outcomes:`);
  for (const [status, n] of Array.from(outcomeCounts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(18)} ${n}`);
  }
  console.log(``);
  console.log(`Pattern matches (curated bugs only):`);
  console.log(`  matched    ${patternMatches.matched}`);
  console.log(`  unmatched  ${patternMatches.unmatched}`);
  console.log(`  unknown    ${patternMatches.unknown}`);
  console.log(``);
  console.log(`Sample (first record):`);
  if (sample[0]) console.log(JSON.stringify(sample[0], null, 2).slice(0, 1500));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
