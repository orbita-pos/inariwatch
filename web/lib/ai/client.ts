/**
 * Web's AI client — Phase 1 of the v0.3 router migration.
 *
 * Per INARI_AI_ARCHITECTURE.md (LOCKED 2026-05-02), every AI call now goes
 * through `@inariwatch/ai-router` dispatch(). This file exists ONLY to:
 *
 *   1. Add InariLens telemetry (web-specific) on top of the router's call.
 *      The router emits substrate-level receipts; lens captures full prompts,
 *      tokens, cost, and feature attribution.
 *   2. Preserve the historical (apiKey, systemPrompt, messages, opts) shape
 *      so the ~14 callers in web/lib/ai/* didn't have to be rewritten end-to-end
 *      in S1.
 *
 * Nothing in this file talks to provider APIs directly — the lockdown rule
 * (`@inariwatch/ai-router/eslint`) blocks that.
 */

import {
  dispatch as routerDispatch,
  callAIWithUsage as routerCallAIWithUsage,
  callAIEmbed as routerCallAIEmbed,
  detectProvider as routerDetectProvider,
  TASKS,
  type AIMessage,
  type AIVisionMessage,
  type AIResponse,
  type AIUsage,
  type AIProvider,
  type ContentBlock,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ToolDefinition,
  type ToolUseResponse,
  type WorkspaceContext,
  type TaskName,
} from "@inariwatch/ai-router";

import type { LensFeature, LensTelemetry } from "./lens";
import { installKeepAliveDispatcher } from "./http-agent";
import { ensureReceiptSinkRegistered } from "@/lib/ai-router/persist-receipt";

// Fase 3 keep-alive dispatcher — installs once at module load. The router's
// internal fetch() inherits the global undici dispatcher, so this still wins
// TLS reuse on every provider call.
installKeepAliveDispatcher();

// v0.3 S2.5 — register the persistent sink for ai_router_receipts. Idempotent
// across HMR / vitest reloads thanks to the router's de-duped sink registry.
ensureReceiptSinkRegistered();

// ── Re-exports (backward-compat for surface code) ──────────────────────────

export type {
  AIMessage,
  AIVisionMessage,
  AIResponse,
  AIUsage,
  AIProvider,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  ToolUseResponse,
};

export const detectProvider = routerDetectProvider;

// ── Lens telemetry shape (web-specific) ────────────────────────────────────

export interface AILogContext extends LensTelemetry {
  userId: string;
  feature: LensFeature;
  projectId?: string | null;
  alertId?: string | null;
  remediationSessionId?: string | null;
  isPlatformKey?: boolean;
  /**
   * Cents pre-reserved against the platform AI budget kill-switch via
   * `reservePlatformBudget()`. The usage logger reconciles by adding
   * (actual - reserved) to the counter on success, or refunds the full
   * reserved amount on error. Pass 0 / omit when not pre-reserving.
   */
  reservedPlatformCents?: number;
}

function pickTelemetryFields(ctx: AILogContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.turnNumber !== undefined && ctx.turnNumber !== null)
    out.turnNumber = ctx.turnNumber;
  if (ctx.ttftMs !== undefined && ctx.ttftMs !== null) out.ttftMs = ctx.ttftMs;
  if (ctx.phase !== undefined && ctx.phase !== null) out.phase = ctx.phase;
  if (ctx.modelTier !== undefined && ctx.modelTier !== null)
    out.modelTier = ctx.modelTier;
  if (ctx.toolName !== undefined && ctx.toolName !== null)
    out.toolName = ctx.toolName;
  if (ctx.toolExecMs !== undefined && ctx.toolExecMs !== null)
    out.toolExecMs = ctx.toolExecMs;
  if (ctx.reasoningTokens !== undefined && ctx.reasoningTokens !== null)
    out.reasoningTokens = ctx.reasoningTokens;
  return out;
}

function workspaceFromLog(log?: AILogContext): WorkspaceContext | undefined {
  if (!log) return undefined;
  return {
    userId: log.userId,
    projectId: log.projectId ?? undefined,
    alertId: log.alertId ?? undefined,
    remediationSessionId: log.remediationSessionId ?? undefined,
    isPlatformKey: log.isPlatformKey ?? false,
  };
}

function logSuccess(
  log: AILogContext | undefined,
  systemPrompt: string,
  messages: AIMessage[],
  response: AIResponse,
  durationMs: number,
): void {
  if (!log) return;
  const telemetry = pickTelemetryFields(log);
  import("./lens")
    .then(({ logAICall, serializePrompt }) => {
      logAICall({
        userId: log.userId,
        projectId: log.projectId,
        alertId: log.alertId,
        remediationSessionId: log.remediationSessionId,
        feature: log.feature,
        provider: response.provider,
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: response.usage.cachedInputTokens,
        isPlatformKey: log.isPlatformKey ?? false,
        reservedPlatformCents: log.reservedPlatformCents ?? 0,
        durationMs,
        prompt: serializePrompt(systemPrompt, messages),
        response: response.text,
        ...telemetry,
      });
    })
    .catch(() => {});
}

function logError(
  log: AILogContext | undefined,
  apiKey: string,
  provider: AIProvider | undefined,
  model: string | undefined,
  systemPrompt: string,
  messages: AIMessage[],
  err: unknown,
  durationMs: number,
): void {
  if (!log) return;
  const telemetry = pickTelemetryFields(log);
  import("./lens")
    .then(({ logAICall, serializePrompt }) => {
      logAICall({
        userId: log.userId,
        projectId: log.projectId,
        alertId: log.alertId,
        remediationSessionId: log.remediationSessionId,
        feature: log.feature,
        provider: provider ?? routerDetectProvider(apiKey),
        model: model ?? "unknown",
        inputTokens: 0,
        outputTokens: 0,
        isPlatformKey: log.isPlatformKey ?? false,
        reservedPlatformCents: log.reservedPlatformCents ?? 0,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
        prompt: serializePrompt(systemPrompt, messages),
        ...telemetry,
      });
    })
    .catch(() => {});
}

// ── Public API (parity with the legacy callAI / callAIWithTools) ───────────

export interface CallAIOpts {
  maxTokens?: number;
  model?: string;
  timeout?: number;
  provider?: AIProvider;
  /** When set, auto-logs usage + cost to ai_usage_logs. */
  log?: AILogContext;
  /**
   * Optional task tag for the router. Defaults to alert.auto-analyze when
   * unspecified. Supplying a precise task improves receipt audit + future
   * Phase-3 routing decisions.
   */
  task?: TaskName;
}

export async function callAI(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: CallAIOpts = {},
): Promise<string> {
  const t0 = Date.now();
  try {
    const response = await routerCallAIWithUsage(
      apiKey,
      systemPrompt,
      messages,
      {
        task: opts.task ?? TASKS.ALERT_AUTO_ANALYZE,
        maxTokens: opts.maxTokens,
        model: opts.model,
        timeout: opts.timeout,
        provider: opts.provider,
        workspace: workspaceFromLog(opts.log),
      },
    );
    logSuccess(opts.log, systemPrompt, messages, response, Date.now() - t0);
    return response.text;
  } catch (err) {
    logError(
      opts.log,
      apiKey,
      opts.provider,
      opts.model,
      systemPrompt,
      messages,
      err,
      Date.now() - t0,
    );
    throw err;
  }
}

export async function callAIWithUsage(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: CallAIOpts = {},
): Promise<AIResponse> {
  const t0 = Date.now();
  try {
    const response = await routerCallAIWithUsage(
      apiKey,
      systemPrompt,
      messages,
      {
        task: opts.task ?? TASKS.ALERT_AUTO_ANALYZE,
        maxTokens: opts.maxTokens,
        model: opts.model,
        timeout: opts.timeout,
        provider: opts.provider,
        workspace: workspaceFromLog(opts.log),
      },
    );
    logSuccess(opts.log, systemPrompt, messages, response, Date.now() - t0);
    return response;
  } catch (err) {
    logError(
      opts.log,
      apiKey,
      opts.provider,
      opts.model,
      systemPrompt,
      messages,
      err,
      Date.now() - t0,
    );
    throw err;
  }
}

/**
 * Call the AI with retries and exponential backoff.
 * Retries on 429 (rate limit), 500/502/503 (server error), and network timeouts.
 * Use this instead of callAI() for critical paths (remediation, diagnosis).
 */
export async function callAIWithRetry(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: CallAIOpts & { retries?: number } = {},
): Promise<string> {
  const maxRetries = opts.retries ?? 2;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callAI(apiKey, systemPrompt, messages, opts);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;
      // Don't retry auth errors (401/403) — they won't succeed on retry.
      if (msg.includes("(401)") || msg.includes("(403)")) throw lastError;
      if (attempt < maxRetries) {
        const delayMs = 1000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  const provider = opts.provider ?? routerDetectProvider(apiKey);
  throw new Error(
    `AI provider "${provider}" failed after ${maxRetries + 1} attempts: ${lastError!.message}`,
  );
}

// ── Vision ──────────────────────────────────────────────────────────────────

export interface CallAIVisionOpts {
  maxTokens?: number;
  model?: string;
  timeout?: number;
  provider?: AIProvider;
  log?: AILogContext;
  task?: TaskName;
}

export async function callAIVision(
  apiKey: string,
  systemPrompt: string,
  message: AIVisionMessage,
  opts: CallAIVisionOpts = {},
): Promise<string> {
  const t0 = Date.now();
  const provider = opts.provider ?? routerDetectProvider(apiKey);
  // Groq + DeepSeek don't support vision — fall back to text-only via callAI.
  if (provider === "groq" || provider === "deepseek") {
    return callAI(
      apiKey,
      systemPrompt,
      [
        {
          role: "user",
          content: `${message.text}\n\n(Screenshot was captured but your AI provider does not support vision. Analysis is text-only.)`,
        },
      ],
      opts,
    );
  }
  try {
    const out = await routerDispatch({
      mode: "vision",
      task: opts.task ?? TASKS.ALERT_AUTO_ANALYZE,
      apiKey,
      systemPrompt,
      message,
      provider: opts.provider,
      maxTokens: opts.maxTokens,
      model: opts.model,
      timeout: opts.timeout,
      workspace: workspaceFromLog(opts.log),
    });
    if (out.mode !== "vision") {
      throw new Error("Internal: dispatch returned non-vision shape");
    }
    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens")
        .then(({ logAICall }) => {
          logAICall({
            userId: opts.log!.userId,
            projectId: opts.log!.projectId,
            alertId: opts.log!.alertId,
            remediationSessionId: opts.log!.remediationSessionId,
            feature: opts.log!.feature,
            provider,
            model: out.model,
            inputTokens: out.usage.inputTokens,
            outputTokens: out.usage.outputTokens,
            cachedInputTokens: out.usage.cachedInputTokens,
            isPlatformKey: opts.log!.isPlatformKey ?? false,
            reservedPlatformCents: opts.log!.reservedPlatformCents ?? 0,
            durationMs: Date.now() - t0,
            // [VISION] marker tells the replay parser to skip — vision calls
            // can't be replayed without the original screenshots.
            prompt: `[VISION]\n[SYSTEM]\n${systemPrompt}\n---\n[USER]\n${message.text}`,
            response: out.text,
            ...telemetry,
          });
        })
        .catch(() => {});
    }
    return out.text;
  } catch (err) {
    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens")
        .then(({ logAICall }) => {
          logAICall({
            userId: opts.log!.userId,
            projectId: opts.log!.projectId,
            alertId: opts.log!.alertId,
            remediationSessionId: opts.log!.remediationSessionId,
            feature: opts.log!.feature,
            provider,
            model: opts.model ?? "unknown",
            inputTokens: 0,
            outputTokens: 0,
            isPlatformKey: opts.log!.isPlatformKey ?? false,
            reservedPlatformCents: opts.log!.reservedPlatformCents ?? 0,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - t0,
            prompt: `[VISION]\n[SYSTEM]\n${systemPrompt}\n---\n[USER]\n${message.text}`,
            ...telemetry,
          });
        })
        .catch(() => {});
    }
    throw err;
  }
}

// ── Tool use (agentic loop) ────────────────────────────────────────────────

export interface CallAIWithToolsOpts {
  maxTokens?: number;
  model?: string;
  timeout?: number;
  provider?: AIProvider;
  log?: AILogContext;
  task?: TaskName;
  // Responses API (GPT-5.x family)
  priorOutput?: Array<Record<string, unknown>>;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  strict?: boolean;
  toolChoice?: "auto" | "required" | { type: "function"; name: string };
  parallelToolCalls?: boolean;
}

export async function callAIWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: CallAIWithToolsOpts = {},
): Promise<ToolUseResponse> {
  const t0 = Date.now();
  const provider = opts.provider ?? routerDetectProvider(apiKey);
  try {
    // Use dispatch() directly so we get back per-turn usage + model — the
    // legacy callAIWithTools helper strips them, which would zero the
    // ai_usage_logs columns for every multi-turn remediation.
    const out = await routerDispatch({
      mode: "tool-use",
      task: opts.task ?? TASKS.CODE_FIX_AGENT_LOOP,
      apiKey,
      systemPrompt,
      messages,
      tools,
      maxTokens: opts.maxTokens,
      model: opts.model,
      timeout: opts.timeout,
      provider: opts.provider,
      workspace: workspaceFromLog(opts.log),
      priorOutput: opts.priorOutput,
      reasoningEffort: opts.reasoningEffort,
      strict: opts.strict,
      toolChoice: opts.toolChoice,
      parallelToolCalls: opts.parallelToolCalls,
    });
    if (out.mode !== "tool-use") {
      throw new Error("Internal: dispatch returned non-tool-use shape");
    }
    const response = out.response;
    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens")
        .then(({ logAICall, serializePrompt }) => {
          // For tool_use turns there's no final text — record a marker listing
          // which tools were called so the admin UI shows what the model did.
          const responseText =
            response.stopReason === "end_turn"
              ? response.text
              : `[tool_use] ${response.content
                  .filter((b): b is ToolUseBlock => b.type === "tool_use")
                  .map(
                    (b) =>
                      `${b.name}(${JSON.stringify(b.input).slice(0, 2000)})`,
                  )
                  .join("\n")}`;

          logAICall({
            userId: opts.log!.userId,
            projectId: opts.log!.projectId,
            alertId: opts.log!.alertId,
            remediationSessionId: opts.log!.remediationSessionId,
            feature: opts.log!.feature,
            provider,
            model: out.model,
            inputTokens: out.usage.inputTokens,
            outputTokens: out.usage.outputTokens,
            cachedInputTokens: out.usage.cachedInputTokens,
            isPlatformKey: opts.log!.isPlatformKey ?? false,
            reservedPlatformCents: opts.log!.reservedPlatformCents ?? 0,
            durationMs: Date.now() - t0,
            prompt: serializePrompt(systemPrompt, messages),
            response: responseText,
            ...telemetry,
          });
        })
        .catch(() => {});
    }
    return response;
  } catch (err) {
    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens")
        .then(({ logAICall, serializePrompt }) => {
          logAICall({
            userId: opts.log!.userId,
            projectId: opts.log!.projectId,
            alertId: opts.log!.alertId,
            remediationSessionId: opts.log!.remediationSessionId,
            feature: opts.log!.feature,
            provider,
            model: opts.model ?? "unknown",
            inputTokens: 0,
            outputTokens: 0,
            isPlatformKey: opts.log!.isPlatformKey ?? false,
            reservedPlatformCents: opts.log!.reservedPlatformCents ?? 0,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - t0,
            prompt: serializePrompt(systemPrompt, messages),
            ...telemetry,
          });
        })
        .catch(() => {});
    }
    throw err;
  }
}

// ── Embeddings (Code Intelligence) ─────────────────────────────────────────

export async function callAIEmbed(
  apiKey: string,
  input: string | string[],
  opts: { task?: TaskName; model?: string; timeout?: number; userId?: string } = {},
): Promise<{
  vectors: number[][];
  model: string;
  usage: { inputTokens: number };
}> {
  return routerCallAIEmbed(apiKey, input, {
    task: opts.task ?? TASKS.CODE_EMBED,
    model: opts.model,
    timeout: opts.timeout,
    workspace: opts.userId ? { userId: opts.userId } : undefined,
  });
}

// ── Cache builders (re-exported for callers that touch raw payloads) ───────

export {
  buildToolsWithCache,
  buildMessagesWithCache,
  buildOpenAIResponsesInput as buildResponsesInput,
} from "@inariwatch/ai-router";
