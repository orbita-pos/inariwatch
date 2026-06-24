/**
 * Platform-funded Together AI routing — best-model-per-role (May 2026).
 *
 * Seven semantic buckets routed across five distinct Together-hosted
 * models. Mirrors the disciplined per-task routing pattern that mature
 * agentic tools converge on (Continue.dev's 6 roles, opencode's
 * `model` + `small_model`, Aider's architect/editor/weak, Claude
 * Code's Opus/Sonnet/Haiku cascade — documented ~51% cost reductions).
 * IDs verified against Together's serverless catalog (2026-05-14).
 *
 *  CHAT_ORCH (chat.conversational, chat.code)
 *      → moonshotai/Kimi-K2.6                  $1.20 / $4.50
 *      Purpose-built for thinking-mode multi-step reasoning + tool
 *      invocation. Same family as K2.5 (262K ctx, FC Yes, Structured
 *      Outputs Yes) but the newer release; K2.5 errored on our
 *      platform Together key (likely tier/region restriction) and
 *      triggered cross-provider fallback to OpenAI with the wrong key.
 *      K2.6 is also already used elsewhere in the repo (the capture
 *      webhook upgraded from Qwen2.5-VL-7B to K2.6). Replaces
 *      Qwen3-235B for chat because Qwen3-235B's MoE deploy on vLLM
 *      hits multi-turn orchestration regressions (silent tool calls,
 *      lost context on short replies, duplicate tool calls across
 *      turns).
 *
 *      NOTE (Phase 4.6 of pure-slash refactor, 2026-05-15): Inari Live
 *      no longer routes through CHAT_ORCH — the desktop chat surface
 *      is pure-slash + autocomplete-only and consumes the ASSIST
 *      bucket on Qwen3.5-9B. CHAT_ORCH is retained because the web
 *      dashboard chat (`web/app/api/chat/route.ts`) and the classify
 *      endpoint (`web/app/api/ai/classify/route.ts`) both still use
 *      `chat.conversational`. Don't remove the bucket without also
 *      retiring those two surfaces.
 *
 *  ANALYSIS (code.review.security, code.review.self, code.risk.assess)
 *      → Qwen/Qwen3-235B-A22B-Instruct-2507-tput  $0.20 / $0.60
 *      MoE flagship, 22B active, thinking-mode via
 *      chat_template_kwargs.enable_thinking. Single-turn analytic
 *      tasks where Qwen3-235B excels — kept untouched.
 *
 *  CLASSIFY (chat.intent-classify, alert.classify, code.fingerprint)
 *      → openai/gpt-oss-20b                    $0.05 / $0.20
 *      Cheapest serious tool-use model on the catalog. For label-
 *      emission and intent routing where we just need a category, not
 *      reasoning. Continue.dev's "small_model" / Aider's "weak-model"
 *      analogue.
 *
 *  APPLY (code.apply.diff, notify.compose.*, redact.pii.*)
 *      → Qwen/Qwen3.5-9B-FP8                   $0.10 / $0.15
 *      Single-turn structured outputs: format an email/Slack message,
 *      apply a diff prose-to-patch, redact PII. Reuses the same model
 *      as ALERT — semantically a different role but same fit.
 *
 *  ASSIST (chat.suggest-command)
 *      → Qwen/Qwen3.5-9B-FP8                   $0.10 / $0.15
 *      Inari Live pure-slash autocomplete: tiny single-shot prompt
 *      (manifest + query → JSON suggestions). ~$0.0001/call at the
 *      target ratio of 500 in / 50 out tokens. Reuses the Qwen3.5-9B
 *      weights but kept in its own semantic bucket so a future swap
 *      (e.g. to gpt-oss-20b for even cheaper) doesn't have to bleed
 *      through ALERT / APPLY.
 *
 *  ALERT (alert.auto-analyze, alert.correlate)
 *      → Qwen/Qwen3.5-9B-FP8                   $0.10 / $0.15
 *      High-volume cheap classifier, kept untouched.
 *
 *  CODE (postmortem, explore)
 *      → Qwen/Qwen3-Coder-Next-FP8             $0.50 / $1.20
 *      Code-aware, output-heavy, kept untouched.
 *
 *  FIX (code.fix.single-shot, code.fix.agent-loop, code.fix.container)
 *      → Qwen/Qwen3.6-Plus                     $0.50 / $3.00
 *      78.8% SWE-bench, top tier for coding on Together. Kept.
 *      DeepSeek-V4-Pro (80.6% SWE-bench) is the next step up — adds
 *      $1.60/Mtok input but offers cached-input at $0.20. Defer until
 *      cache hit rates measured.
 *
 * Flag off (INARI_TOGETHER_PLATFORM_FUNDED_ENABLED != "true") = zero
 * behavior change; callers fall back to their BYOK provider/model.
 */

import type { AIProvider } from "@inariwatch/ai-router";
import type { AITask, RemediationPhase } from "./models";
import { getPlatformTogetherKey } from "./get-key";

/** Code-generation tasks (postmortem, explore) — Qwen3-Coder-Next (code-aware, FP8 throughput). */
export const TOGETHER_QWEN_CODER = "Qwen/Qwen3-Coder-Next-FP8";

/** Alert analysis + APPLY tier (notify compose, redact, diff apply) — cheapest Qwen in catalog. */
export const TOGETHER_ALERT_TIER = "Qwen/Qwen3.5-9B-FP8";

/**
 * ASSIST tier (Inari Live pure-slash autocomplete) — Qwen3.5-9B.
 *
 * Same weights as ALERT/APPLY but kept as a separate constant so the
 * `chat.suggest-command` task can be repointed (e.g. to gpt-oss-20b for
 * even cheaper) without bleeding into the alert pipeline. The model is
 * tiny by design: per the pure-slash plan the LLM gets the manifest +
 * the user's query and returns ~3 JSON suggestions — no multi-turn
 * orchestration, no tool catalog, no agency.
 */
export const TOGETHER_ASSIST_TIER = "Qwen/Qwen3.5-9B-FP8";

/** Single-turn analysis (security/self review, risk assess) — Qwen3-235B-A22B MoE flagship. */
export const TOGETHER_QWEN3_FLAGSHIP = "Qwen/Qwen3-235B-A22B-Instruct-2507-tput";

/** Code fix — Qwen3.6-Plus (78.8% SWE-bench). */
export const TOGETHER_QWEN36_PLUS = "Qwen/Qwen3.6-Plus";

/**
 * Multi-turn chat with tool orchestration — Moonshot Kimi K2.6.
 *
 * Originally targeted K2.5 but production with `moonshotai/Kimi-K2.5`
 * returned errors that triggered the rule's fallback to OpenAI (with
 * the wrong key, surfacing as a 401 with a `tgp_*` token at the
 * OpenAI endpoint). Per Together's catalog (verified 2026-05-15) K2.6
 * is the newer release in the same family with identical 262K ctx,
 * Function Calling: Yes, Structured Outputs: Yes, plus a documented
 * "thinking mode for multi-step reasoning and tool invocation". Same
 * purpose-built tool orchestration; defaulting to the newer release
 * sidesteps any tier/region restriction that may have hit K2.5.
 *
 * Replaces Qwen3-235B for chat.* — Qwen3-235B's MoE deploy on vLLM
 * hits multi-turn orchestration regressions (silent tool calls, lost
 * context on short replies, duplicate tool calls across turns).
 */
export const TOGETHER_KIMI_K25 = "moonshotai/Kimi-K2.6";

/**
 * Cheap classification / intent routing — OpenAI's open-weights 20B.
 * Continue.dev's "small_model" / Aider's "weak-model" analogue.
 * Cheapest tool-use-flagged model on the Together serverless catalog.
 */
export const TOGETHER_GPT_OSS_20B = "openai/gpt-oss-20b";

export type TogetherRoutingTarget = {
  provider: AIProvider;
  model: string;
};

/**
 * Returns whether the env flag is on. Reads `process.env` on every call so
 * a kamal env push (no rebuild) flips behavior immediately.
 */
export function isTogetherPlatformFundedEnabled(): boolean {
  return process.env.INARI_TOGETHER_PLATFORM_FUNDED_ENABLED === "true";
}

/** Postmortem + explore — Qwen3-Coder-Next (code-aware, output-heavy). */
const CODE_ROUTED: ReadonlySet<string> = new Set<AITask | RemediationPhase>([
  "postmortem",
  "explore",
]);

/** Alert ingestion analysis — Qwen3.5-9B (cheap classifier). */
const ALERT_ROUTED: ReadonlySet<string> = new Set([
  "alert.auto-analyze",
  "alert.correlate",
]);

/** Code fix tasks — Qwen3.6-Plus (strongest available on Together AI for coding). */
const FIX_ROUTED: ReadonlySet<string> = new Set([
  "code.fix",
  "code.fix.single-shot",
  "code.fix.agent-loop",
  "code.fix.container",
]);

/**
 * Multi-turn chat with tool orchestration — Kimi K2.6. Both
 * `chat.conversational` (Inari Live's main loop) and `chat.code`
 * (code-related conversational follow-ups) live here because both are
 * tool-orchestration shaped, not single-turn analytic.
 */
const CHAT_ORCH_ROUTED: ReadonlySet<string> = new Set([
  "chat.conversational",
  "chat.code",
]);

/**
 * Single-turn analytic tasks — Qwen3-235B-A22B (MoE flagship, 22B
 * active, thinking mode via chat_template_kwargs.enable_thinking,
 * multilingual EN+ES). Chat tasks moved out of this bucket as of
 * 2026-05-15 — see CHAT_ORCH_ROUTED above.
 */
const ANALYSIS_ROUTED: ReadonlySet<string> = new Set([
  "code.review.security",
  "code.review.self",
  "code.risk.assess",
]);

/**
 * Classification / intent routing / fingerprinting — gpt-oss-20b
 * (cheapest tool-use-flagged model on Together). Tasks here just emit
 * a category label; reasoning quality is overkill, throughput +
 * latency dominate.
 */
const CLASSIFY_ROUTED: ReadonlySet<string> = new Set([
  "chat.intent-classify",
  "alert.classify",
  "code.fingerprint",
]);

/**
 * APPLY tier — single-turn structured outputs (compose a notification,
 * apply a diff, redact PII). Reuses Qwen3.5-9B-FP8 (same model as
 * ALERT_ROUTED) — semantically a different role but same fit + cost.
 * Notify tasks are LOCAL-when-online per tasks.ts; this routing
 * applies in the cloud-fallback path only.
 */
const APPLY_ROUTED: ReadonlySet<string> = new Set([
  "code.apply.diff",
  "notify.compose.email",
  "notify.compose.slack",
  "notify.compose.telegram",
  "notify.compose.whatsapp",
  "notify.compose.push",
  "notify.compose.digest",
  "notify.compose.status-page",
  "notify.compose.postmortem-prose",
  "redact.pii.breadcrumbs",
  "redact.pii.stacktrace",
]);

/**
 * ASSIST tier — Inari Live pure-slash autocomplete. Distinct semantic
 * bucket so a future model swap on this one surface (cheap, latency-
 * sensitive, low-stakes) doesn't drag ALERT / APPLY along.
 */
const ASSIST_ROUTED: ReadonlySet<string> = new Set([
  "chat.suggest-command",
]);

/**
 * Models that support Together's `enable_thinking` chat template flag.
 * Used by `_openai-compat-shared.ts` to gate the thinking-mode payload
 * — sending it to a non-supporting model is a silent no-op on Together's
 * side, but we'd rather not send it at all.
 */
const THINKING_SUPPORTED_PREFIXES = [
  "Qwen/Qwen3-235B",
  "Qwen/Qwen3.6",
  "Qwen/Qwen3-Coder",
];

export function modelSupportsThinking(model: string): boolean {
  return THINKING_SUPPORTED_PREFIXES.some((p) => model.startsWith(p));
}

/**
 * Resolve the platform-funded Together target for a given task or phase.
 * Returns null when the flag is off OR the task is not routed — caller
 * keeps its existing provider/model unchanged.
 */
export function resolveTargetForPlatformFunded(
  taskOrPhase: AITask | RemediationPhase | string,
): TogetherRoutingTarget | null {
  if (!isTogetherPlatformFundedEnabled()) return null;
  if (FIX_ROUTED.has(taskOrPhase))       return { provider: "together", model: TOGETHER_QWEN36_PLUS };
  if (CODE_ROUTED.has(taskOrPhase))      return { provider: "together", model: TOGETHER_QWEN_CODER };
  if (CHAT_ORCH_ROUTED.has(taskOrPhase)) return { provider: "together", model: TOGETHER_KIMI_K25 };
  if (ANALYSIS_ROUTED.has(taskOrPhase))  return { provider: "together", model: TOGETHER_QWEN3_FLAGSHIP };
  if (CLASSIFY_ROUTED.has(taskOrPhase))  return { provider: "together", model: TOGETHER_GPT_OSS_20B };
  // APPLY uses the same model as ALERT — kept as a separate set so the
  // semantic role stays explicit and a future model swap on either
  // tier doesn't accidentally pick up the other.
  if (ALERT_ROUTED.has(taskOrPhase))     return { provider: "together", model: TOGETHER_ALERT_TIER };
  if (APPLY_ROUTED.has(taskOrPhase))     return { provider: "together", model: TOGETHER_ALERT_TIER };
  if (ASSIST_ROUTED.has(taskOrPhase))    return { provider: "together", model: TOGETHER_ASSIST_TIER };
  return null;
}

/**
 * One-call helper for callers that need key + provider + model together.
 *
 * Returns null when:
 *   - Flag is off
 *   - Task is not in any routed set
 *   - PLATFORM_TOGETHER_KEY / TOGETHER_API_KEY is not set
 *
 * Usage:
 *   const t = getTogetherOverride("chat.conversational", aiKey.isPlatformKey);
 *   const key      = t?.key      ?? aiKey.key;
 *   const provider = t?.provider ?? aiKey.provider;
 *   const model    = t?.model    ?? resolveModel("chat", aiKey.provider, aiKey.modelPrefs);
 */
export function getTogetherOverride(
  task: string,
  isPlatformKey: boolean | undefined,
): { key: string; provider: AIProvider; model: string } | null {
  if (!isPlatformKey) return null;
  const target = resolveTargetForPlatformFunded(task);
  if (!target) return null;
  const keyResult = getPlatformTogetherKey();
  if (!keyResult) return null;
  return { key: keyResult.key, provider: target.provider, model: target.model };
}
