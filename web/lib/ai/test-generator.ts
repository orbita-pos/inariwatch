/**
 * Inari Guard — `/test <path>` orchestrator.
 *
 * Three-pass pipeline:
 *   Pass 1  Plan   — Qwen3-Coder-Next-FP8 ($0.50/$1.20)
 *                    Produces { framework, cases: [{name, scenario, ...}] }
 *   Pass 2  Write  — Qwen3-Coder-480B-A35B-Instruct-FP8 ($2.00 flat)
 *                    Produces { path, content } for the test file
 *   Pass 3  Review — Qwen3-235B-A22B with thinking ($0.20/$0.60)
 *                    Produces { approved, score, rewrite_hint, ... }
 *
 * Plus deterministic static quality gates (test-quality-gates.ts) that
 * MUST pass before we mark a session 'ready'. Combined:
 *   AI reviewer catches semantic slop (assertions that miss the point,
 *     mocks that aren't used, names that describe implementation).
 *   Static gates catch syntactic slop (zero assertions, expect(true),
 *     hardcoded waits, file >500 LOC).
 *
 * Total cost per file: ~$0.10 - $0.15. Total wall time: 30-60s typical.
 *
 * Model selection follows the principle:
 *   "Don't use expensive models when cheap ones do the job equally."
 *   - PLAN is structured reasoning → cheap coder is enough.
 *   - WRITE is the one place quality matters most → flagship coder.
 *   - REVIEW is critique, not generation → cheap analysis model with
 *     thinking mode (we already pay for this; ~$0.001/review).
 */

import { callAI } from "./client";
import { getTogetherOverride } from "./together-routing";
import {
  SYSTEM_TEST_PLANNER,
  SYSTEM_TEST_WRITER,
  SYSTEM_TEST_REVIEWER,
  buildTestPlanPrompt,
  buildTestWritePrompt,
  buildTestReviewPrompt,
  type TestPlan,
  type TestReviewResult,
} from "./prompts";
import { runQualityGates, type QualityGatesResult } from "./test-quality-gates";
import { cleanJSON } from "./json-utils";

// ── Public API ──────────────────────────────────────────────────────────────

export interface GenerateTestsParams {
  /** File path relative to repo root. */
  filePath: string;
  /** Full file content (caller fetches from GitHub / local clone). */
  fileContent: string;
  /** Up to 5 caller snippets to inform what the happy path actually is. */
  callers?: { path: string; snippet: string }[];
  /** Up to 3 existing test files for style matching. */
  existingTests?: { path: string; content: string }[];
  /** Override framework auto-detect (e.g. 'playwright', 'vitest'). */
  frameworkHint?: string;
  /** Active project's AI key (platform-funded or BYOK). */
  apiKey: string;
  /** Together's PLATFORM_TOGETHER_KEY presence — drives router override. */
  isPlatformKey: boolean;
  /** Step-by-step events for SSE streaming to the desktop client. */
  emit?: (event: string, data: Record<string, unknown>) => void;
  /** InariLens log context. */
  log?: {
    userId: string;
    projectId: string;
    alertId?: string | null;
    sessionId?: string | null;
  };
}

export interface GenerateTestsResult {
  status: "ready" | "failed";
  testFile?: { path: string; content: string };
  plan?: TestPlan;
  review?: TestReviewResult;
  qualityGates?: QualityGatesResult;
  /** Which model handled each pass (for telemetry + audit). */
  modelsUsed: { plan: string | null; write: string | null; review: string | null };
  /** Token + cost totals across all 3 passes. */
  tokensIn: { plan: number; write: number; review: number };
  tokensOut: { plan: number; write: number; review: number };
  costCents: number;
  /** When status === 'failed', explains which stage broke. */
  error?: string;
  /** Total wall-clock from start to finish. */
  durationMs: number;
}

// ── Implementation ──────────────────────────────────────────────────────────

const PASS_MAX_TOKENS = {
  plan:   800,    // JSON plan, terse
  write:  4096,   // Test file body, up to ~500 lines
  review: 600,    // JSON verdict, terse
};

const PASS_TIMEOUTS = {
  plan:   45_000,
  write:  90_000,  // Qwen3-Coder-480B is slow on first call
  review: 45_000,
};

const MAX_REWRITE_RETRIES = 1;

/**
 * Pricing per million tokens for cost estimation. Lives here so we don't
 * import a heavy pricing module. Updated when we change model routing.
 *
 * Source: Together AI catalog 2026-05-13 (verified via scripts/verify-
 * qwen-migration.ps1). Hardcoded because together-routing.ts only knows
 * model IDs, not prices.
 */
const PRICING_PER_M = {
  "Qwen/Qwen3-Coder-Next-FP8":                              { in: 0.50, out: 1.20 },
  "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8":                { in: 2.00, out: 2.00 },
  "Qwen/Qwen3-235B-A22B-Instruct-2507-tput":                { in: 0.20, out: 0.60 },
  "Qwen/Qwen3.6-Plus":                                       { in: 0.50, out: 3.00 },
  // Sensible default for unmapped models — slightly conservative.
  default:                                                   { in: 1.00, out: 2.00 },
};

function priceFor(model: string | null | undefined): { in: number; out: number } {
  if (!model) return PRICING_PER_M.default;
  return (PRICING_PER_M as Record<string, { in: number; out: number }>)[model] ?? PRICING_PER_M.default;
}

/** Approximate token count via the 4-chars-per-token heuristic. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Cents = (input_tokens × $/M) + (output_tokens × $/M), rounded to nearest cent. */
function computeCostCents(
  modelsUsed: GenerateTestsResult["modelsUsed"],
  tokensIn: GenerateTestsResult["tokensIn"],
  tokensOut: GenerateTestsResult["tokensOut"],
): number {
  const pass = (model: string | null, tIn: number, tOut: number): number => {
    const p = priceFor(model);
    return (tIn / 1_000_000) * p.in + (tOut / 1_000_000) * p.out;
  };
  const totalUsd =
    pass(modelsUsed.plan,   tokensIn.plan,   tokensOut.plan) +
    pass(modelsUsed.write,  tokensIn.write,  tokensOut.write) +
    pass(modelsUsed.review, tokensIn.review, tokensOut.review);
  return Math.round(totalUsd * 100);
}

/**
 * Generate tests for a single file.
 *
 * Never throws. On any failure (model error, malformed JSON, all reviews
 * rejecting, quality gates blocking) returns `status: "failed"` with an
 * `error` explaining the stage that broke. The caller logs to the
 * `test_generation_sessions` table.
 */
export async function generateTests(params: GenerateTestsParams): Promise<GenerateTestsResult> {
  const t0 = Date.now();
  const emit = params.emit ?? (() => undefined);

  const modelsUsed: GenerateTestsResult["modelsUsed"] = { plan: null, write: null, review: null };
  const tokensIn:  GenerateTestsResult["tokensIn"]    = { plan: 0, write: 0, review: 0 };
  const tokensOut: GenerateTestsResult["tokensOut"]   = { plan: 0, write: 0, review: 0 };

  // ── Pass 1: Plan ──────────────────────────────────────────────────────
  emit("test_gen.pass", { phase: "plan", status: "started" });
  const planTarget = getTogetherOverride("explore", params.isPlatformKey);
  const planModel = planTarget?.model ?? "Qwen/Qwen3-Coder-Next-FP8";
  modelsUsed.plan = planModel;

  const planPrompt = buildTestPlanPrompt({
    filePath: params.filePath,
    fileContent: params.fileContent,
    callers: params.callers,
    existingTests: params.existingTests,
    frameworkHint: params.frameworkHint,
  });
  tokensIn.plan = estimateTokens(SYSTEM_TEST_PLANNER + planPrompt);

  let plan: TestPlan;
  try {
    const planRaw = await callAI(
      planTarget?.key ?? params.apiKey,
      SYSTEM_TEST_PLANNER,
      [{ role: "user", content: planPrompt }],
      {
        maxTokens:   PASS_MAX_TOKENS.plan,
        timeout:     PASS_TIMEOUTS.plan,
        model:       planModel,
        provider:    planTarget?.provider ?? "together",
        jsonMode:    true,
        temperature: 0.2,
        log: params.log
          ? {
              userId: params.log.userId,
              projectId: params.log.projectId,
              alertId: params.log.alertId ?? undefined,
              feature: "test-generation" as const,
              phase: "explore" as const, // LensPhase: plan-pass maps to 'explore'
              isPlatformKey: params.isPlatformKey,
            }
          : undefined,
      },
    );
    tokensOut.plan = estimateTokens(planRaw);
    plan = JSON.parse(cleanJSON(planRaw)) as TestPlan;
    if (!plan?.cases || !Array.isArray(plan.cases) || plan.cases.length === 0) {
      throw new Error("planner returned no cases");
    }
  } catch (err) {
    return finish("failed", t0, modelsUsed, tokensIn, tokensOut, undefined, undefined, undefined, undefined,
      `Pass 1 (plan) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  emit("test_gen.pass", {
    phase: "plan",
    status: "done",
    cases: plan.cases.length,
    framework: plan.framework,
    high: plan.cases.filter((c) => c.priority === "high").length,
  });

  // ── Pass 2: Write (with up to 1 retry on reviewer rejection) ──────────
  const writeTarget = getTogetherOverride("code.fix.single-shot", params.isPlatformKey);
  // The router's code.fix tasks point at Qwen3.6-Plus which is SWE-bench tuned
  // for FIXING code, not WRITING tests. Tests are a code-gen task that
  // benefits from the coder flagship (480B) explicitly. Override the model
  // even when the override resolves so we get the right tool for the job.
  const writeModel = "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8";
  modelsUsed.write = writeModel;

  const reviewTarget = getTogetherOverride("code.review.self", params.isPlatformKey);
  const reviewModel = reviewTarget?.model ?? "Qwen/Qwen3-235B-A22B-Instruct-2507-tput";
  modelsUsed.review = reviewModel;

  let testFile: { path: string; content: string } | undefined;
  let review: TestReviewResult | undefined;
  let rewriteHint: string | undefined;

  for (let attempt = 0; attempt <= MAX_REWRITE_RETRIES; attempt++) {
    emit("test_gen.pass", { phase: "write", status: "started", attempt: attempt + 1 });

    const writePrompt = buildTestWritePrompt({
      filePath: params.filePath,
      fileContent: params.fileContent,
      plan,
      existingTests: params.existingTests ?? [],
      rewriteHint,
    });
    tokensIn.write += estimateTokens(SYSTEM_TEST_WRITER + writePrompt);

    let writeRaw: string;
    try {
      writeRaw = await callAI(
        writeTarget?.key ?? params.apiKey,
        SYSTEM_TEST_WRITER,
        [{ role: "user", content: writePrompt }],
        {
          maxTokens:   PASS_MAX_TOKENS.write,
          timeout:     PASS_TIMEOUTS.write,
          model:       writeModel,
          provider:    writeTarget?.provider ?? "together",
          jsonMode:    true,
          temperature: 0.3,
          log: params.log
            ? {
                userId: params.log.userId,
                projectId: params.log.projectId,
                alertId: params.log.alertId ?? undefined,
                feature: "test-generation" as const,
                phase: "fix" as const, // LensPhase: write-pass maps to 'fix'
                isPlatformKey: params.isPlatformKey,
              }
            : undefined,
        },
      );
      tokensOut.write += estimateTokens(writeRaw);
    } catch (err) {
      return finish("failed", t0, modelsUsed, tokensIn, tokensOut, plan, undefined, undefined, undefined,
        `Pass 2 (write, attempt ${attempt + 1}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let candidate: { path: string; content: string };
    try {
      candidate = JSON.parse(cleanJSON(writeRaw));
      if (!candidate?.path || !candidate?.content) {
        throw new Error("writer returned malformed { path, content }");
      }
    } catch (err) {
      return finish("failed", t0, modelsUsed, tokensIn, tokensOut, plan, undefined, undefined, undefined,
        `Pass 2 parse failed (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`);
    }
    emit("test_gen.pass", { phase: "write", status: "done", attempt: attempt + 1, path: candidate.path });

    // ── Pass 3: Review ─────────────────────────────────────────────────
    emit("test_gen.pass", { phase: "review", status: "started", attempt: attempt + 1 });
    const reviewPrompt = buildTestReviewPrompt({ plan, generatedTests: candidate });
    tokensIn.review += estimateTokens(SYSTEM_TEST_REVIEWER + reviewPrompt);

    let reviewRaw: string;
    try {
      reviewRaw = await callAI(
        reviewTarget?.key ?? params.apiKey,
        SYSTEM_TEST_REVIEWER,
        [{ role: "user", content: reviewPrompt }],
        {
          maxTokens:      PASS_MAX_TOKENS.review,
          timeout:        PASS_TIMEOUTS.review,
          model:          reviewModel,
          provider:       reviewTarget?.provider ?? "together",
          jsonMode:       true,
          temperature:    0.1,
          // Thinking mode pays for itself on the reviewer because it surfaces
          // the SUBTLE issues (mocks unused, assertions that miss the bug)
          // that a one-shot generation would gloss over. ~$0.001 extra.
          thinkingBudget: 1500,
          log: params.log
            ? {
                userId: params.log.userId,
                projectId: params.log.projectId,
                alertId: params.log.alertId ?? undefined,
                feature: "test-generation" as const,
                phase: "review" as const,
                isPlatformKey: params.isPlatformKey,
              }
            : undefined,
        },
      );
      tokensOut.review += estimateTokens(reviewRaw);
    } catch (err) {
      return finish("failed", t0, modelsUsed, tokensIn, tokensOut, plan, candidate, undefined, undefined,
        `Pass 3 (review, attempt ${attempt + 1}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      review = JSON.parse(cleanJSON(reviewRaw)) as TestReviewResult;
      if (typeof review?.approved !== "boolean") {
        throw new Error("reviewer returned malformed verdict");
      }
    } catch (err) {
      return finish("failed", t0, modelsUsed, tokensIn, tokensOut, plan, candidate, undefined, undefined,
        `Pass 3 parse failed (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`);
    }
    emit("test_gen.pass", {
      phase: "review",
      status: "done",
      attempt: attempt + 1,
      approved: review.approved,
      score: review.score,
      rejected: review.rejected_cases?.length ?? 0,
    });

    if (review.approved) {
      testFile = candidate;
      break;
    }

    // Not approved — set the hint for the next write attempt, loop.
    rewriteHint = review.rewrite_hint || review.concerns?.join("; ") || "Rewrite to address reviewer concerns.";
    testFile = candidate; // Save in case we hit MAX_REWRITE_RETRIES and want to return the latest draft
  }

  if (!testFile) {
    return finish("failed", t0, modelsUsed, tokensIn, tokensOut, plan, undefined, review, undefined,
      "Three-pass loop exhausted with no candidate produced");
  }

  if (review && !review.approved) {
    return finish("failed", t0, modelsUsed, tokensIn, tokensOut, plan, testFile, review, undefined,
      `AI reviewer rejected after ${MAX_REWRITE_RETRIES + 1} attempt(s): ${review.rewrite_hint}`);
  }

  // ── Static quality gates ──────────────────────────────────────────────
  emit("test_gen.gates", { status: "started" });
  const qualityGates = runQualityGates({
    testFile,
    sourceContent: params.fileContent,
  });
  emit("test_gen.gates", {
    status: "done",
    approved: qualityGates.approved,
    failed_count: qualityGates.failed.length,
    failures: qualityGates.failed,
  });

  if (!qualityGates.approved) {
    return finish("failed", t0, modelsUsed, tokensIn, tokensOut, plan, testFile, review, qualityGates,
      `Quality gates rejected: ${qualityGates.failed.slice(0, 3).join("; ")}`);
  }

  return finish("ready", t0, modelsUsed, tokensIn, tokensOut, plan, testFile, review, qualityGates);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function finish(
  status: "ready" | "failed",
  t0: number,
  modelsUsed: GenerateTestsResult["modelsUsed"],
  tokensIn: GenerateTestsResult["tokensIn"],
  tokensOut: GenerateTestsResult["tokensOut"],
  plan?: TestPlan,
  testFile?: { path: string; content: string },
  review?: TestReviewResult,
  qualityGates?: QualityGatesResult,
  error?: string,
): GenerateTestsResult {
  return {
    status,
    testFile,
    plan,
    review,
    qualityGates,
    modelsUsed,
    tokensIn,
    tokensOut,
    costCents: computeCostCents(modelsUsed, tokensIn, tokensOut),
    error,
    durationMs: Date.now() - t0,
  };
}
