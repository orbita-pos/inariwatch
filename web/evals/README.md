# Eval harness for the remediation pipeline

This directory houses the eval suite for the AI remediation pipeline.
It runs in two modes:

1. **Local-only** (default) — loads `golden-dataset-v*.jsonl`, replays
   each record through a pluggable scoring function, prints a report
   and writes `eval-report.json`. No external dependency.

2. **Braintrust-mirrored** (opt-in) — same execution, but also streams
   inputs/outputs/scores to a Braintrust project so the web dashboard
   shows runs + regression diffs across commits. Enabled by setting
   `BRAINTRUST_API_KEY` + `BRAINTRUST_PROJECT` in the environment.

## How to run

```bash
# Local-only, against the shipped golden dataset
cd web
npx tsx evals/coding-agent.eval.ts

# Different dataset
npx tsx evals/coding-agent.eval.ts --dataset=golden-dataset-v4.jsonl

# Upload to Braintrust too (set both env vars)
BRAINTRUST_API_KEY=sk-... BRAINTRUST_PROJECT=inariwatch \
  npx tsx evals/coding-agent.eval.ts
```

## Metrics reported

| Metric | What it means | Gate |
|---|---|---|
| `success_rate` | % of records where pipeline generated a fix that matched expected pattern (curated bugs) or produced a non-null fix (real alerts) | -5% triggers CI fail |
| `avg_cost_usd` | Mean cost per session (from `ai_usage_logs.cost_usd` summed by session) | +20% triggers CI fail |
| `avg_turns` | Mean remediation steps per session | informational |
| `avg_self_review` | Mean self-review score for sessions that had a fix | informational |
| `pattern_match_rate` | % of curated-bug entries where fix matched expected regex | -10% triggers CI fail |

## Gate behavior (PR CI)

The `.github/workflows/eval-ai.yml` workflow runs this eval against
the golden dataset on PRs that touch `web/lib/ai/**`. It compares the
PR branch's numbers against `main`'s baseline (stored in
`evals/baseline.json`). If any gate fails, the PR is blocked until
either:

- The regression is fixed, OR
- The baseline is updated explicitly (documented as a deliberate
  trade-off in the PR description)

## Writing a new eval

The entry point is `coding-agent.eval.ts`. Each eval record goes
through:

1. `prepareInput(record)` — shapes the dataset JSONL into the input
   the pipeline expects
2. `runPipeline(input)` — replays the remediation pipeline. In
   local-only mode this reuses the session already in the DB; in a
   full re-run mode it creates a fresh session and calls
   `runRemediation()` (slow, uses real budget)
3. `scorers(expected, output)` — array of `{name, score}` pairs
   producing per-record metrics
4. Aggregated and written to `eval-report.json`

To add a scorer, append to `SCORERS` in the eval file. A scorer
returns a number in `[0, 1]` and optionally a human-readable label.
