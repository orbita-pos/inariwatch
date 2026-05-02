/**
 * OpenAI Graders API integration (Fase 1 — Telemetry Foundation).
 *
 * v0.3 S2.5: the raw `api.openai.com` fetch now lives inside
 * `packages/ai-router/src/providers/openai.ts` (`runGrader`). This file is
 * a domain wrapper that loads golden-dataset rows, builds the model_sample
 * string, and dispatches one Graders run per row through the router. The
 * lockdown rule is satisfied — no `eslint-disable` needed.
 *
 * Kill switch:
 *   GRADERS_ENABLED=false  (default) — runGoldenDataset() throws
 *                                       `GradersDisabledError` immediately.
 *   GRADERS_ENABLED=true               — runs against OPENAI_API_KEY.
 *
 * Reference: https://platform.openai.com/docs/api-reference/graders
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { runGrader } from "@inariwatch/ai-router";

// ── Public types ───────────────────────────────────────────────────────────

/** Shape of one row in web/golden-dataset-v4.jsonl. */
export interface GoldenDatasetRecord {
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

/**
 * Grader definition. This mirrors the OpenAI Graders alpha schema — see
 * docs link at the top of this file. Fase 1 uses two kinds:
 *   - `string_check` for deterministic regex checks (cheap, no LLM cost)
 *   - `label_model` for quality judgments (LLM-as-judge, costs tokens)
 */
export type GraderConfig =
  | StringCheckGrader
  | LabelModelGrader
  | MultiGrader;

export interface StringCheckGrader {
  type: "string_check";
  name: string;
  input: string;        // reference string (regex)
  reference: string;    // reference key path (unused by API but kept for parity)
  operation: "eq" | "ne" | "like" | "ilike";
}

export interface LabelModelGrader {
  type: "label_model";
  name: string;
  model: string;        // e.g., "gpt-4o-mini"
  passing_labels: string[];
  labels: string[];
  input: Array<{ role: "developer" | "user" | "assistant"; content: string }>;
}

export interface MultiGrader {
  type: "multi";
  name: string;
  graders: Record<string, StringCheckGrader | LabelModelGrader>;
  calculate_output: string; // arithmetic expression across sub-grader results
}

/** Model configuration for the run — which model scored, how many samples. */
export interface GraderModelConfig {
  /** Label recorded in the report — e.g., "gpt-5.4-mini" or "fine-tuned-2026-04-22". */
  modelLabel: string;
  /** Dataset file name relative to web/. Defaults to golden-dataset-v4.jsonl. */
  dataset?: string;
  /** Max concurrent Graders API calls. Defaults to 8; stay under provider rate limit. */
  concurrency?: number;
  /** Per-call timeout, default 30s. Aggregate budget enforced by runGoldenDataset. */
  perCallTimeoutMs?: number;
  /** Optional override for the Graders endpoint (tests inject mocks here). */
  endpoint?: string;
  /** Optional override for the OpenAI API key (tests inject fakes). */
  apiKey?: string;
  /** Grader config. Defaults to a pattern_match string_check against expected.fix_pattern. */
  grader?: GraderConfig;
}

export interface GraderRowResult {
  sessionId: string;
  bugId: string | null;
  score: number;
  passed: boolean;
  label: string | null;
  error: string | null;
}

export interface GraderReport {
  dataset: string;
  modelLabel: string;
  grader: string;
  recordCount: number;
  passRate: number;
  averageScore: number;
  durationMs: number;
  rows: GraderRowResult[];
  generatedAt: string;
}

export class GradersDisabledError extends Error {
  constructor() {
    super("Graders API is disabled. Set GRADERS_ENABLED=true to enable.");
    this.name = "GradersDisabledError";
  }
}

// ── Internal ───────────────────────────────────────────────────────────────

// Default endpoint lives inside the router (`runGrader` defaults). Tests
// inject overrides via `config.endpoint`.
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 30_000;
const TOTAL_BUDGET_MS = 5 * 60 * 1000; // Fase 1 acceptance: report in < 5 min.

/** Default grader: pattern_match on expected.fix_pattern. */
function defaultGrader(): StringCheckGrader {
  return {
    type: "string_check",
    name: "fix_pattern_match",
    input: "{{ sample.output }}",
    reference: "{{ item.expected.fix_pattern }}",
    operation: "like",
  };
}

function loadDataset(path: string): GoldenDatasetRecord[] {
  const raw = readFileSync(resolve(path), "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((l, i) => {
    try {
      return JSON.parse(l) as GoldenDatasetRecord;
    } catch (err) {
      throw new Error(
        `Failed to parse ${path}:${i + 1}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}

function isGradersEnabled(): boolean {
  return process.env.GRADERS_ENABLED === "true";
}

/**
 * Call the Graders alpha endpoint with a single model_sample + item. Returns
 * the raw grade payload. The caller is responsible for mapping `reward` /
 * `metadata.sampled_model_name` onto its own report shape.
 */
async function runSingleGrade(
  grader: GraderConfig,
  modelSample: string,
  item: GoldenDatasetRecord,
  opts: { endpoint?: string; apiKey: string; timeoutMs: number }
): Promise<{ reward: number; metadata: Record<string, unknown> }> {
  return runGrader({
    apiKey: opts.apiKey,
    endpoint: opts.endpoint,
    grader: grader as unknown as Record<string, unknown>,
    modelSample,
    item,
    timeoutMs: opts.timeoutMs,
  });
}

/** Minimal concurrency pool so we stay under OpenAI rate limits without a dep. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function next(): Promise<void> {
    const idx = cursor++;
    if (idx >= items.length) return;
    results[idx] = await worker(items[idx], idx);
    return next();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Score a golden-dataset file through the OpenAI Graders API and return an
 * aggregated report. Completes within the Fase 1 acceptance budget (<5min)
 * for golden-dataset-v4 (11 rows) at concurrency=8.
 *
 * Throws `GradersDisabledError` when the feature flag is off. Throws any
 * other error from the underlying HTTP call; callers are expected to catch
 * and route to the admin UI.
 */
export async function runGoldenDataset(config: GraderModelConfig): Promise<GraderReport> {
  if (!isGradersEnabled() && !config.apiKey) {
    // Tests override via config.apiKey; production must flip the env flag.
    throw new GradersDisabledError();
  }

  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.PLATFORM_AI_KEY;
  if (!apiKey) {
    throw new Error("Graders run requires OPENAI_API_KEY or PLATFORM_AI_KEY.");
  }

  const dataset = config.dataset ?? "golden-dataset-v4.jsonl";
  const records = loadDataset(dataset);

  const grader = config.grader ?? defaultGrader();
  const endpoint = config.endpoint;
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const perCallTimeoutMs = config.perCallTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const t0 = Date.now();

  // modelSample is the text the grader scores. For Fase 1 we feed the
  // pre-recorded fix_summary + fix_files from the dataset output so runs
  // are deterministic (no secondary LLM call). Fase 10 will plug in a live
  // model invocation before grading.
  const rows = await mapLimit(records, concurrency, async (rec) => {
    if (Date.now() - t0 > TOTAL_BUDGET_MS) {
      return {
        sessionId: rec.metadata.session_id,
        bugId: rec.expected?.bug_id ?? null,
        score: 0,
        passed: false,
        label: null,
        error: "total-budget-exceeded",
      } satisfies GraderRowResult;
    }

    const modelSample = buildModelSample(rec);

    try {
      const { reward } = await runSingleGrade(grader, modelSample, rec, {
        endpoint,
        apiKey,
        timeoutMs: perCallTimeoutMs,
      });
      return {
        sessionId: rec.metadata.session_id,
        bugId: rec.expected?.bug_id ?? null,
        score: reward,
        passed: reward >= 0.5,
        label: null,
        error: null,
      } satisfies GraderRowResult;
    } catch (err) {
      return {
        sessionId: rec.metadata.session_id,
        bugId: rec.expected?.bug_id ?? null,
        score: 0,
        passed: false,
        label: null,
        error: err instanceof Error ? err.message : String(err),
      } satisfies GraderRowResult;
    }
  });

  const passed = rows.filter((r) => r.passed).length;
  const total = rows.length;
  const sum = rows.reduce((s, r) => s + r.score, 0);

  return {
    dataset,
    modelLabel: config.modelLabel,
    grader: grader.name,
    recordCount: total,
    passRate: total > 0 ? passed / total : 0,
    averageScore: total > 0 ? sum / total : 0,
    durationMs: Date.now() - t0,
    rows,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Render the grader's `model_sample` string from a dataset record. Fase 1
 * concatenates diagnosis + fix summary + first-file preview because the
 * default grader checks for the expected regex anywhere in the model's
 * output.
 */
export function buildModelSample(rec: GoldenDatasetRecord): string {
  const parts: string[] = [];
  if (rec.output.diagnosis_excerpt) parts.push(rec.output.diagnosis_excerpt);
  if (rec.output.fix_summary) parts.push(rec.output.fix_summary);
  for (const f of rec.output.fix_files) {
    parts.push(`--- ${f.path}\n${f.content_preview}`);
  }
  return parts.join("\n\n");
}
