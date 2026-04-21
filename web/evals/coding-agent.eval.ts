/**
 * Eval harness for the remediation pipeline (PR #10).
 *
 * Loads golden-dataset-v*.jsonl, scores each record against a set of
 * scorers, aggregates into metrics, and writes eval-report.json.
 * Gated in CI via `.github/workflows/eval-ai.yml`.
 *
 * Local-first: runs without Braintrust account. If BRAINTRUST_API_KEY
 * is set, also streams to Braintrust for dashboards and regression
 * diffs across commits.
 *
 * Usage:
 *   npx tsx evals/coding-agent.eval.ts
 *   npx tsx evals/coding-agent.eval.ts --dataset=golden-dataset-v4.jsonl
 *   npx tsx evals/coding-agent.eval.ts --baseline=evals/baseline.json
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── Types ────────────────────────────────────────────────────────────────────

interface DatasetRecord {
  input: {
    alert_title: string;
    alert_body: string;
    alert_source: string[];
    alert_repo: string | null;
    alert_fingerprint: string | null;
  };
  expected: {
    fix_pattern: string;
    pattern_matched: boolean | null;
    bug_id: string;
  } | null;
  output: {
    diagnosis_excerpt: string | null;
    fix_summary: string | null;
    fix_files: Array<{ path: string; content_preview: string }>;
    self_review_score: number | null;
    confidence: number | null;
    outcome: string;
    pr_url: string | null;
    merge_strategy: string | null;
  };
  metadata: {
    session_id: string;
    project: string | null;
    attempts: string;
    error: string | null;
    step_count: number;
    created_at?: string;
    duration_s: number | null;
  };
}

interface Score { name: string; score: number; label?: string }

interface EvalReport {
  dataset: string;
  recordCount: number;
  metrics: {
    success_rate: number;
    pattern_match_rate: number;
    avg_turns: number;
    avg_self_review: number;
    avg_confidence: number;
    avg_duration_s: number;
    failure_by_reason: Record<string, number>;
  };
  records: Array<{
    session_id: string;
    bug_id: string | null;
    outcome: string;
    scores: Score[];
  }>;
  timestamp: string;
}

// ── Scorers ──────────────────────────────────────────────────────────────────

type Scorer = (rec: DatasetRecord) => Score;

const patternMatch: Scorer = (rec) => {
  if (!rec.expected) return { name: "pattern_match", score: 0, label: "not-curated" };
  const joined = rec.output.fix_files.map((f) => f.content_preview).join("\n");
  try {
    const re = new RegExp(rec.expected.fix_pattern);
    const hit = re.test(joined);
    return { name: "pattern_match", score: hit ? 1 : 0, label: hit ? "hit" : "miss" };
  } catch {
    return { name: "pattern_match", score: 0, label: "regex-error" };
  }
};

const fixGenerated: Scorer = (rec) => {
  const ok = rec.output.fix_files.length > 0;
  return { name: "fix_generated", score: ok ? 1 : 0, label: ok ? "yes" : "no" };
};

const reachedGreen: Scorer = (rec) => {
  const greenStatuses = new Set(["completed", "merging", "approved", "proposing", "awaiting_ci"]);
  const ok = greenStatuses.has(rec.output.outcome);
  return { name: "reached_green", score: ok ? 1 : 0, label: rec.output.outcome };
};

const selfReviewPass: Scorer = (rec) => {
  const score = rec.output.self_review_score ?? 0;
  const ok = score >= 70;
  return { name: "self_review_pass", score: ok ? 1 : 0, label: String(score) };
};

const notDisabled: Scorer = (rec) => {
  // Penalize fixes that "removed" or "disabled" code instead of fixing — a
  // pattern we observed in the `fetch failed` replay where AI deleted the
  // failing code path.
  const joined = rec.output.fix_files.map((f) => f.content_preview).join("\n");
  const fixSummary = rec.output.fix_summary ?? "";
  const suspicious = /\b(disabled?|removed?|deleted?|skipped?)\b.*(?:fetch|endpoint|handler|call)/i.test(fixSummary);
  return { name: "not_disabled", score: suspicious ? 0 : 1, label: suspicious ? "removed-code" : "ok" };
};

const SCORERS: Scorer[] = [patternMatch, fixGenerated, reachedGreen, selfReviewPass, notDisabled];

// ── Main ─────────────────────────────────────────────────────────────────────

interface Args {
  dataset: string;
  baseline: string | null;
  out: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const dataset = args.find((a) => a.startsWith("--dataset="))?.split("=")[1] ?? "golden-dataset-v4.jsonl";
  const baseline = args.find((a) => a.startsWith("--baseline="))?.split("=")[1] ?? null;
  const out = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "eval-report.json";
  return { dataset, baseline, out };
}

async function main() {
  const { dataset, baseline, out } = parseArgs();

  const datasetPath = resolve(process.cwd(), dataset);
  if (!existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    process.exit(1);
  }

  const lines = readFileSync(datasetPath, "utf-8").trim().split("\n").filter(Boolean);
  const records: DatasetRecord[] = lines.map((l) => JSON.parse(l));

  console.log(`\n=== Eval: coding-agent ===`);
  console.log(`Dataset:     ${dataset} (${records.length} records)`);
  console.log(`Braintrust:  ${process.env.BRAINTRUST_API_KEY ? "enabled" : "disabled (set BRAINTRUST_API_KEY)"}`);
  console.log(``);

  // ── Score each record
  const scoredRecords = records.map((rec) => ({
    session_id: rec.metadata.session_id,
    bug_id: rec.expected?.bug_id ?? null,
    outcome: rec.output.outcome,
    scores: SCORERS.map((s) => s(rec)),
  }));

  // ── Aggregate metrics
  const mean = (vals: number[]) => vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

  const successVals = scoredRecords.map((r) => r.scores.find((s) => s.name === "fix_generated")!.score);
  const patternVals = scoredRecords.filter((r) => r.bug_id).map((r) => r.scores.find((s) => s.name === "pattern_match")!.score);
  const selfReviewVals = records.filter((r) => r.output.self_review_score != null).map((r) => r.output.self_review_score!);
  const confidenceVals = records.filter((r) => r.output.confidence != null).map((r) => r.output.confidence!);
  const durationVals = records.filter((r) => r.metadata.duration_s != null).map((r) => r.metadata.duration_s!);
  const turnsVals = records.map((r) => r.metadata.step_count);

  const failureReasons: Record<string, number> = {};
  for (const r of records) {
    if (r.output.outcome === "failed") {
      const e = r.metadata.error ?? "";
      let reason = "other";
      if (e.includes("write access")) reason = "github_permissions";
      else if (e.includes("CI still failing")) reason = "ci_failures";
      else if (e.includes("repository")) reason = "repo_resolution";
      else if (e.includes("concurrent")) reason = "concurrency";
      else if (e.includes("budget")) reason = "budget";
      else if (e.includes("quota")) reason = "quota";
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    }
  }

  const report: EvalReport = {
    dataset,
    recordCount: records.length,
    metrics: {
      success_rate: mean(successVals),
      pattern_match_rate: mean(patternVals),
      avg_turns: mean(turnsVals),
      avg_self_review: mean(selfReviewVals),
      avg_confidence: mean(confidenceVals),
      avg_duration_s: mean(durationVals),
      failure_by_reason: failureReasons,
    },
    records: scoredRecords,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(out, JSON.stringify(report, null, 2));

  // ── Print report
  console.log(`## Metrics\n`);
  console.log(`  success_rate        ${fmtPct(report.metrics.success_rate)}`);
  console.log(`  pattern_match_rate  ${fmtPct(report.metrics.pattern_match_rate)} (${patternVals.length} curated)`);
  console.log(`  avg_turns           ${report.metrics.avg_turns.toFixed(1)}`);
  console.log(`  avg_self_review     ${report.metrics.avg_self_review.toFixed(1)}`);
  console.log(`  avg_confidence      ${report.metrics.avg_confidence.toFixed(1)}%`);
  console.log(`  avg_duration_s      ${report.metrics.avg_duration_s.toFixed(0)}s`);
  console.log(``);
  console.log(`## Failure breakdown\n`);
  for (const [reason, n] of Object.entries(failureReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(22)} ${n}`);
  }
  console.log(``);

  // ── Baseline comparison & gating
  let gateFailed = false;
  if (baseline && existsSync(baseline)) {
    const base = JSON.parse(readFileSync(baseline, "utf-8")) as EvalReport;
    console.log(`## Regression check vs ${baseline}\n`);
    const successDelta = report.metrics.success_rate - base.metrics.success_rate;
    const patternDelta = report.metrics.pattern_match_rate - base.metrics.pattern_match_rate;
    const costDelta = 0; // TODO: wire actual cost aggregation when we stream usage into dataset

    const verdict = (delta: number, gate: number, invert = false) => {
      const bad = invert ? delta > gate : delta < -gate;
      return bad ? "❌ FAIL" : "✅ pass";
    };
    const gateMsgs: string[] = [];

    gateMsgs.push(`  success_rate        ${fmtPct(report.metrics.success_rate)} (Δ ${fmtPctDelta(successDelta)})   ${verdict(successDelta, 0.05)}`);
    if (successDelta < -0.05) gateFailed = true;

    gateMsgs.push(`  pattern_match_rate  ${fmtPct(report.metrics.pattern_match_rate)} (Δ ${fmtPctDelta(patternDelta)})  ${verdict(patternDelta, 0.10)}`);
    if (patternDelta < -0.10) gateFailed = true;

    for (const m of gateMsgs) console.log(m);
  } else {
    console.log(`(no baseline supplied; skipping gate. first run? pin a baseline: cp ${out} evals/baseline.json)`);
  }

  // ── Braintrust mirror (opt-in)
  if (process.env.BRAINTRUST_API_KEY) {
    try {
      await mirrorToBraintrust(records, scoredRecords, report);
    } catch (err) {
      console.warn(`Braintrust mirror failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nReport written to: ${out}`);
  process.exit(gateFailed ? 1 : 0);
}

function fmtPct(v: number) { return `${(v * 100).toFixed(1)}%`.padStart(7); }
function fmtPctDelta(v: number) {
  const s = `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  return s.padStart(7);
}

async function mirrorToBraintrust(
  records: DatasetRecord[],
  scored: Array<{ session_id: string; bug_id: string | null; outcome: string; scores: Score[] }>,
  report: EvalReport,
) {
  // Dynamic import — Braintrust is an optional dep. We hide the
  // import behind a Function constructor so TypeScript doesn't try to
  // resolve the package at build time when the user hasn't installed
  // it. At runtime, the static analysis dodge is harmless.
  const project = process.env.BRAINTRUST_PROJECT ?? "inariwatch-remediation";
  try {
    const mod = await (Function("return import('braintrust')")() as Promise<unknown>);
    const { Eval } = mod as unknown as { Eval: (project: string, opts: unknown) => Promise<unknown> };
    await Eval(project, {
      data: () => records.map((r, i) => ({
        input: r.input,
        expected: r.expected,
        metadata: { session_id: r.metadata.session_id, bug_id: r.expected?.bug_id ?? null },
      })),
      task: async (input: DatasetRecord["input"]) => {
        // We don't re-run the pipeline inside the eval — the dataset
        // already captured the output. The "task" is identity over the
        // stored output, indexed by fingerprint.
        const rec = records.find((r) => r.input.alert_fingerprint === input.alert_fingerprint);
        return rec?.output ?? null;
      },
      scores: records.map((_, i) => scored[i].scores.map((s) => ({
        name: s.name,
        score: s.score,
        metadata: { label: s.label },
      }))).flat(),
    });
    console.log(`\n✓ mirrored to Braintrust project "${project}"`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      console.log(`(braintrust package not installed — run \`npm install braintrust\` to enable mirror)`);
      return;
    }
    throw err;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
