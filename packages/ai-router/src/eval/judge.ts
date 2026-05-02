// v0.3 S3 — eval scorer for `notify.compose.email` outputs.
//
// Two layers:
//   1. Hard rubric (deterministic) — keyword presence/absence + length
//      window + suggested-actions count. Returns a 0-60 sub-score.
//   2. Soft LLM-as-judge (GPT-4o-mini by default) — tone, factual
//      accuracy, action specificity. Returns a 0-40 sub-score.
//
// The judge interface is a function so tests can plug in a deterministic
// mock. `gpt4oMiniJudge` is the production implementation; pass it
// explicitly in CLI runs and unit tests bypass it via `mockJudge`.
//
// Final score is the SUM (max 100). The router promotion rule is:
//   - mean score across corpus ≥ 85 → flip rule confidently
//   - 80-85 → ship behind workspace flag (S3 default), monitor via /admin/ops
//   - <80 → block. tune prompt or pick a stronger model.

import type {
  ComposeEmailEvalItem,
  ComposeEmailEvalRubric,
} from "./corpus";

/** Output the runner expects from each composition (regardless of substrate). */
export interface ComposeEmailEvalOutput {
  subject: string;
  body: string;
  suggested_actions: string[];
}

/** Per-item score detail. Aggregator averages `score`. */
export interface ItemScore {
  id: string;
  score: number;          // 0-100
  rubricScore: number;    // 0-60
  judgeScore: number;     // 0-40
  rubricFailures: string[];
  judgeReasoning?: string;
}

/** LLM-as-judge interface. Production wires `gpt4oMiniJudge`. */
export type JudgeFn = (
  item: ComposeEmailEvalItem,
  output: ComposeEmailEvalOutput,
) => Promise<{ score: number; reasoning: string }>;

// ── Hard rubric (deterministic) ────────────────────────────────────────────

/** Score 0-60. Matches the weights documented at the module top. */
export function scoreRubric(
  rubric: ComposeEmailEvalRubric,
  output: ComposeEmailEvalOutput,
): { score: number; failures: string[] } {
  const failures: string[] = [];
  let score = 60;

  // Subject keywords — at least ONE must appear, case-insensitive.
  if (rubric.subjectKeywords && rubric.subjectKeywords.length > 0) {
    const subjectLc = output.subject.toLowerCase();
    const found = rubric.subjectKeywords.some((kw) =>
      subjectLc.includes(kw.toLowerCase()),
    );
    if (!found) {
      failures.push(
        `subject missing all keywords [${rubric.subjectKeywords.join(", ")}]`,
      );
      score -= 10;
    }
  }

  // Body must-contain — every entry counted; missing = -5 each, max -30.
  if (rubric.bodyMustContain && rubric.bodyMustContain.length > 0) {
    const bodyLc = output.body.toLowerCase();
    let missing = 0;
    for (const phrase of rubric.bodyMustContain) {
      if (!bodyLc.includes(phrase.toLowerCase())) {
        missing += 1;
        failures.push(`body missing '${phrase}'`);
      }
    }
    score -= Math.min(30, missing * 5);
  }

  // Body must-NOT-contain — each occurrence is -10, max -30.
  if (rubric.bodyMustNotContain && rubric.bodyMustNotContain.length > 0) {
    const bodyLc = output.body.toLowerCase();
    let leaks = 0;
    for (const phrase of rubric.bodyMustNotContain) {
      if (bodyLc.includes(phrase.toLowerCase())) {
        leaks += 1;
        failures.push(`body leaked '${phrase}'`);
      }
    }
    score -= Math.min(30, leaks * 10);
  }

  // Length window — outside the window deducts 10.
  const minLen = rubric.minLengthChars ?? 30;
  const maxLen = rubric.maxLengthChars ?? 1500;
  if (output.body.length < minLen) {
    failures.push(`body too short (${output.body.length} < ${minLen})`);
    score -= 10;
  } else if (output.body.length > maxLen) {
    failures.push(`body too long (${output.body.length} > ${maxLen})`);
    score -= 10;
  }

  // Suggested-actions count — out-of-range deducts 10.
  const [minA, maxA] = rubric.expectedActionsRange ?? [1, 4];
  if (output.suggested_actions.length < minA || output.suggested_actions.length > maxA) {
    failures.push(
      `actions count ${output.suggested_actions.length} outside [${minA}, ${maxA}]`,
    );
    score -= 10;
  }

  return { score: Math.max(0, score), failures };
}

// ── LLM-as-judge ───────────────────────────────────────────────────────────

/**
 * Build the judge prompt. Kept identical for cloud + local outputs so the
 * judge sees them the same way — the only thing that changes between runs
 * is the substrate of the email being evaluated.
 */
export function buildJudgePrompt(
  item: ComposeEmailEvalItem,
  output: ComposeEmailEvalOutput,
): { system: string; user: string } {
  const system =
    "You are evaluating an alert email for an incident-management product. " +
    "Score the email on a 0-40 scale based on FOUR axes (10 points each):\n" +
    "1. Tone match — concise/detailed + recipient role appropriate\n" +
    "2. Factual accuracy — references real fields from the alert, no hallucinated numbers/URLs\n" +
    "3. Action specificity — suggested_actions are concrete and relevant (not generic 'investigate')\n" +
    "4. Language correctness — matches requested language (en/es), no mixed-language drift\n\n" +
    "Respond with strict JSON, no commentary or markdown:\n" +
    '{"score": <0-40>, "reasoning": "<one sentence>"}';

  const user = JSON.stringify({
    alert: item.input.alert,
    recipient_role: item.input.recipient_role,
    tone: item.input.tone,
    language: item.input.language,
    composition: output,
  });
  return { system, user };
}

/**
 * GPT-4o-mini judge. Takes a fetch-like function so tests can stub it
 * deterministically. The cloud path uses the existing `dispatch()`
 * infrastructure but goes through the same fetch global so test mocks
 * via `globalThis.fetch` continue to work.
 */
export function makeGpt4oMiniJudge(opts: {
  apiKey: string;
  baseUrl?: string;
  /** Optional fetch override — mostly for tests. Defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Optional model override; defaults to gpt-4o-mini. */
  model?: string;
}): JudgeFn {
  const fetchImpl = opts.fetcher ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const model = opts.model ?? "gpt-4o-mini";
  return async (item, output) => {
    const { system, user } = buildJudgePrompt(item, output);
    const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // Force JSON output; lets us parse without brace-walking.
        response_format: { type: "json_object" },
        // Low temperature — judge stability is more important than creativity.
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      throw new Error(`judge http ${res.status}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const raw = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: { score?: number; reasoning?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`judge returned non-JSON: ${raw.slice(0, 200)}`);
    }
    const score = clamp(toNumber(parsed.score, 0), 0, 40);
    return {
      score,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function toNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ── Per-item scorer (combines rubric + judge) ──────────────────────────────

export async function scoreItem(
  item: ComposeEmailEvalItem,
  output: ComposeEmailEvalOutput,
  judge: JudgeFn,
): Promise<ItemScore> {
  const { score: rubricScore, failures } = scoreRubric(item.rubric, output);
  const judgement = await judge(item, output);
  const judgeScore = clamp(judgement.score, 0, 40);
  return {
    id: item.id,
    score: rubricScore + judgeScore,
    rubricScore,
    judgeScore,
    rubricFailures: failures,
    judgeReasoning: judgement.reasoning,
  };
}

// ── Aggregate report ───────────────────────────────────────────────────────

export interface EvalReport {
  task: string;
  substrate: string;
  model: string | null;
  n_examples: number;
  mean_score: number;
  passed: boolean; // mean_score ≥ 85
  examples: ItemScore[];
}

/**
 * Reduce per-item scores to a final report. The promotion threshold (85)
 * mirrors the eval gate documented in `INARI_LIVE_V0_3_HANDOFF.md` v0.3
 * S3 § Acceptance criteria.
 */
export const PROMOTION_THRESHOLD = 85;

export function buildReport(opts: {
  task: string;
  substrate: string;
  model: string | null;
  examples: ItemScore[];
}): EvalReport {
  const mean =
    opts.examples.length === 0
      ? 0
      : opts.examples.reduce((sum, e) => sum + e.score, 0) /
        opts.examples.length;
  return {
    task: opts.task,
    substrate: opts.substrate,
    model: opts.model,
    n_examples: opts.examples.length,
    mean_score: round(mean, 1),
    passed: mean >= PROMOTION_THRESHOLD,
    examples: opts.examples,
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
