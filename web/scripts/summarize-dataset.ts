/**
 * Render a human-readable markdown summary of the golden dataset JSONL.
 * Groups by source, shows fix quality for curated bugs, flags systemic
 * failure modes (token permissions, missing CI, etc.).
 */
import { readFileSync, writeFileSync } from "fs";

const inPath = process.argv[2] ?? "golden-dataset-v2.jsonl";
const outPath = process.argv[3] ?? "golden-dataset-summary.md";

interface DatasetRecord {
  input: { alert_title: string; alert_source: string[]; alert_repo: string | null };
  expected: { fix_pattern: string; pattern_matched: boolean | null; bug_id: string } | null;
  output: {
    diagnosis_excerpt: string | null;
    fix_summary: string | null;
    fix_files: Array<{ path: string; content_preview: string }>;
    self_review_score: number | null;
    confidence: number | null;
    outcome: string;
  };
  metadata: { session_id: string; project: string; attempts: string; error: string | null; duration_s: number | null };
}

const lines = readFileSync(inPath, "utf-8").trim().split("\n");
const records: DatasetRecord[] = lines.map((l) => JSON.parse(l));

const md: string[] = [];
md.push(`# Golden Dataset Summary\n`);
md.push(`Generated from ${inPath} (${records.length} sessions)\n`);

// Outcomes
const byOutcome = new Map<string, number>();
for (const r of records) byOutcome.set(r.output.outcome, (byOutcome.get(r.output.outcome) ?? 0) + 1);
md.push(`## Outcomes\n`);
md.push(`| Status | Count |`);
md.push(`|---|---|`);
for (const [s, n] of Array.from(byOutcome.entries()).sort((a, b) => b[1] - a[1])) md.push(`| ${s} | ${n} |`);
md.push(``);

// Curated bugs
const curated = records.filter((r) => r.expected);
md.push(`## Curated bugs (${curated.length})\n`);
md.push(`| Bug | Confidence | Self-Review | Pattern Match | Outcome | Fix Summary |`);
md.push(`|---|---|---|---|---|---|`);
for (const r of curated) {
  const match = r.expected!.pattern_matched ? "✅" : "❌";
  const sum = (r.output.fix_summary ?? "—").replace(/\|/g, "\\|").slice(0, 120);
  md.push(`| ${r.expected!.bug_id} | ${r.output.confidence ?? "—"}% | ${r.output.self_review_score ?? "—"} | ${match} | ${r.output.outcome} | ${sum} |`);
}
md.push(``);

// Curated bug fix code samples
md.push(`## Fix code (curated bugs)\n`);
for (const r of curated) {
  md.push(`### ${r.expected!.bug_id}`);
  md.push(`**Alert:** \`${r.input.alert_title}\`  `);
  md.push(`**Confidence:** ${r.output.confidence}% · **Self-Review:** ${r.output.self_review_score} · **Pattern Match:** ${r.expected!.pattern_matched ? "YES" : "NO"}`);
  md.push(``);
  for (const f of r.output.fix_files.slice(0, 1)) {
    md.push(`\`${f.path}\`:`);
    md.push("```js");
    md.push(f.content_preview.split("\n").slice(0, 15).join("\n"));
    md.push("```");
  }
  md.push(``);
}

// Failure modes
md.push(`## Failure modes\n`);
const failures = records.filter((r) => r.output.outcome === "failed");
const modes = new Map<string, number>();
for (const f of failures) {
  const err = f.metadata.error ?? "";
  let mode = "other";
  if (err.includes("write access")) mode = "github_permissions";
  else if (err.includes("CI still failing")) mode = "ci_failures";
  else if (err.includes("concurrent")) mode = "concurrency_queued";
  else if (err.includes("repository")) mode = "repo_resolution";
  modes.set(mode, (modes.get(mode) ?? 0) + 1);
}
md.push(`| Mode | Count | Meaning |`);
md.push(`|---|---|---|`);
for (const [m, n] of Array.from(modes.entries()).sort((a, b) => b[1] - a[1])) {
  const meaning: Record<string, string> = {
    github_permissions: "GitHub token missing write scopes — reconnect integration",
    ci_failures: "Fix generated + pushed, but CI doesn't pass (demo-store has no CI workflow)",
    concurrency_queued: "Hit per-project or global concurrency — can be retried",
    repo_resolution: "alert.repo null + no default — legacy fallback failed",
    other: "See full error",
  };
  md.push(`| ${m} | ${n} | ${meaning[m]} |`);
}
md.push(``);

// Non-curated sessions (real alerts)
const real = records.filter((r) => !r.expected);
md.push(`## Real production alerts (${real.length})\n`);
md.push(`| Session | Source | Repo | Outcome | Confidence | Summary |`);
md.push(`|---|---|---|---|---|---|`);
for (const r of real.slice(0, 20)) {
  const sum = (r.output.fix_summary ?? r.metadata.error ?? "—").slice(0, 100).replace(/\|/g, "\\|").replace(/\n/g, " ");
  md.push(
    `| ${r.metadata.session_id.slice(0, 8)} | ${r.input.alert_source.join(",")} | ${(r.input.alert_repo ?? "—").slice(0, 30)} | ${r.output.outcome} | ${r.output.confidence ?? "—"}% | ${sum} |`
  );
}
md.push(``);

// Key metrics
md.push(`## Key metrics\n`);
const matched = curated.filter((r) => r.expected!.pattern_matched === true).length;
const withFix = records.filter((r) => r.output.fix_files.length > 0).length;
const avgConf = records.filter((r) => r.output.confidence != null).reduce((s, r) => s + r.output.confidence!, 0) / Math.max(1, records.filter((r) => r.output.confidence != null).length);
const avgSelfReview = records.filter((r) => r.output.self_review_score != null).reduce((s, r) => s + r.output.self_review_score!, 0) / Math.max(1, records.filter((r) => r.output.self_review_score != null).length);
md.push(`- **Pattern match rate (curated)**: ${matched}/${curated.length}`);
md.push(`- **Sessions that produced a fix**: ${withFix}/${records.length}`);
md.push(`- **Avg diagnosis confidence**: ${avgConf.toFixed(1)}% (across ${records.filter((r) => r.output.confidence != null).length})`);
md.push(`- **Avg self-review score**: ${avgSelfReview.toFixed(1)}/100 (across ${records.filter((r) => r.output.self_review_score != null).length})`);
md.push(``);

writeFileSync(outPath, md.join("\n"));
console.log(`Wrote ${outPath}`);
console.log(md.join("\n"));
