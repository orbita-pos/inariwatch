/**
 * Unified AI client — Claude, OpenAI, Grok, DeepSeek, Gemini, Groq.
 * Grok, DeepSeek, and Groq are OpenAI-compatible (different base URL).
 * Gemini uses its own REST API.
 */

import type { LensFeature, LensTelemetry } from "./lens";

export type AIMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };
export type AIVisionMessage = { role: "user"; text: string; imageBase64: string; beforeImageBase64?: string };

export type AIProvider = "claude" | "openai" | "grok" | "deepseek" | "gemini" | "groq";

// ── Tool Use Types ──────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type TextBlock = { type: "text"; text: string };
export type ContentBlock = ToolUseBlock | ToolResultBlock | TextBlock;

export type ToolUseResponse =
  | { stopReason: "tool_use"; content: ContentBlock[]; responseId?: string; priorOutput?: Array<Record<string, unknown>> }
  | { stopReason: "end_turn"; text: string; responseId?: string; priorOutput?: Array<Record<string, unknown>> };

/**
 * Detect the AI provider from the key prefix.
 * sk- (without ant-) is ambiguous between OpenAI and DeepSeek — defaults to "openai".
 * For DeepSeek keys, callers must pass provider explicitly via opts.provider.
 */
export function detectProvider(key: string): AIProvider {
  if (key.startsWith("sk-ant-")) return "claude";
  if (key.startsWith("xai-"))    return "grok";
  if (key.startsWith("gsk_"))    return "groq";
  if (key.startsWith("AIza"))    return "gemini";
  return "openai"; // sk-... → openai (DeepSeek also uses sk- but is disambiguated via explicit service)
}

/** Usage metadata extracted from provider responses. */
export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** AI response with text + token usage for cost tracking. */
export interface AIResponse {
  text: string;
  usage: AIUsage;
  model: string;
  provider: AIProvider;
}

/**
 * Optional per-call cost-tracking metadata. When provided, the client
 * auto-logs token usage + computed cost to `ai_usage_logs` after the call
 * completes. Each feature passes its own userId + feature name.
 *
 * `LensTelemetry` adds the Fase 1 per-turn/per-tool fields (phase,
 * turnNumber, modelTier, toolName, etc.). Callers that know the phase
 * boundary (agentic-loop, container-agent in Fase 3) populate these so
 * the /admin/remediation-lab widget can group by phase / tier / model.
 */
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

export interface CallAIOpts {
  maxTokens?: number;
  model?: string;
  timeout?: number;
  provider?: AIProvider;
  /** When set, auto-logs usage + cost to ai_usage_logs. */
  log?: AILogContext;
}

/**
 * Pick the optional Fase 1 telemetry fields (phase, turnNumber, modelTier,
 * toolName, toolExecMs, reasoningTokens, ttftMs) off an `AILogContext`
 * so they can be spread into every `logAICall` site without repeating the
 * field list. Returns an empty object when none are set — avoids writing
 * null-filled rows for callers that don't opt in.
 */
function pickTelemetryFields(ctx: AILogContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.turnNumber !== undefined && ctx.turnNumber !== null) out.turnNumber = ctx.turnNumber;
  if (ctx.ttftMs !== undefined && ctx.ttftMs !== null) out.ttftMs = ctx.ttftMs;
  if (ctx.phase !== undefined && ctx.phase !== null) out.phase = ctx.phase;
  if (ctx.modelTier !== undefined && ctx.modelTier !== null) out.modelTier = ctx.modelTier;
  if (ctx.toolName !== undefined && ctx.toolName !== null) out.toolName = ctx.toolName;
  if (ctx.toolExecMs !== undefined && ctx.toolExecMs !== null) out.toolExecMs = ctx.toolExecMs;
  if (ctx.reasoningTokens !== undefined && ctx.reasoningTokens !== null) out.reasoningTokens = ctx.reasoningTokens;
  return out;
}

/**
 * Call the AI with a system prompt + messages and return the text response.
 * Pass opts.provider to override auto-detection (required for DeepSeek).
 *
 * If `opts.log` is set, the call's token counts + cost are auto-recorded
 * to the ai_usage_logs table (fire-and-forget — logging errors never crash
 * the actual AI feature).
 */
export async function callAI(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: CallAIOpts = {}
): Promise<string> {
  const t0 = Date.now();
  try {
    const response = await callAIWithUsage(apiKey, systemPrompt, messages, opts);
    if (opts.log) {
      // Fire-and-forget via InariLens: captures prompt + response alongside
      // usage. Dynamic import keeps the client module free of a load-time
      // dep on the DB layer (matters for scripts / tools that import it).
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens").then(({ logAICall, serializePrompt }) => {
        logAICall({
          userId: opts.log!.userId,
          projectId: opts.log!.projectId,
          alertId: opts.log!.alertId,
          remediationSessionId: opts.log!.remediationSessionId,
          feature: opts.log!.feature,
          provider: response.provider,
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cachedInputTokens: response.usage.cachedInputTokens,
          isPlatformKey: opts.log!.isPlatformKey ?? false,
          reservedPlatformCents: opts.log!.reservedPlatformCents ?? 0,
          durationMs: Date.now() - t0,
          prompt: serializePrompt(systemPrompt, messages),
          response: response.text,
          ...telemetry,
        });
      }).catch(() => {});
    }
    return response.text;
  } catch (err) {
    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens").then(({ logAICall, serializePrompt }) => {
        logAICall({
          userId: opts.log!.userId,
          projectId: opts.log!.projectId,
          alertId: opts.log!.alertId,
          remediationSessionId: opts.log!.remediationSessionId,
          feature: opts.log!.feature,
          provider: opts.provider ?? detectProvider(apiKey),
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
      }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Call the AI and return both the text response AND the usage metadata
 * (token counts) for cost tracking via the usage logger.
 *
 * Prefer using `callAI` with the `log` option instead — it handles
 * logging automatically. Only use this function when you explicitly
 * need the raw token counts in caller code.
 */
export async function callAIWithUsage(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: CallAIOpts = {}
): Promise<AIResponse> {
  const provider = opts.provider ?? detectProvider(apiKey);

  switch (provider) {
    case "claude":
      return callClaudeWithUsage(apiKey, systemPrompt, messages, opts);
    case "grok":
      return callOpenAICompatWithUsage(apiKey, systemPrompt, messages, opts, "https://api.x.ai/v1", "grok");
    case "groq":
      return callOpenAICompatWithUsage(apiKey, systemPrompt, messages, opts, "https://api.groq.com/openai/v1", "groq");
    case "deepseek":
      return callOpenAICompatWithUsage(apiKey, systemPrompt, messages, opts, "https://api.deepseek.com/v1", "deepseek");
    case "gemini":
      return callGeminiWithUsage(apiKey, systemPrompt, messages, opts);
    default:
      return callOpenAICompatWithUsage(apiKey, systemPrompt, messages, opts, "https://api.openai.com/v1", "openai");
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
  opts: CallAIOpts & { retries?: number } = {}
): Promise<string> {
  const maxRetries = opts.retries ?? 2;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callAI(apiKey, systemPrompt, messages, opts);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry auth errors (401/403) — they won't succeed on retry
      const msg = lastError.message;
      if (msg.includes("(401)") || msg.includes("(403)")) throw lastError;
      if (attempt < maxRetries) {
        const delayMs = 1000 * (attempt + 1); // 1s, 2s, 3s...
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  const provider = opts.provider ?? detectProvider(apiKey);
  throw new Error(`AI provider "${provider}" failed after ${maxRetries + 1} attempts: ${lastError!.message}`);
}

/** Opts for callAIVision — accepts optional log context for InariLens. */
export interface CallAIVisionOpts {
  maxTokens?: number;
  model?: string;
  timeout?: number;
  provider?: AIProvider;
  /** When set, auto-logs usage + cost + prompt/response to InariLens. */
  log?: AILogContext;
}

/**
 * Call the AI with a screenshot (base64 PNG) and a text prompt.
 * Uses the user's BYOK provider. All major providers support vision.
 * Groq and DeepSeek don't support vision — falls back to text-only with a note.
 *
 * If `opts.log` is set, the call is recorded to InariLens with the prompt
 * prefixed by `[VISION]`. Screenshots are NOT persisted — only the text.
 */
export async function callAIVision(
  apiKey: string,
  systemPrompt: string,
  message: AIVisionMessage,
  opts: CallAIVisionOpts = {}
): Promise<string> {
  const provider = opts.provider ?? detectProvider(apiKey);
  const t0 = Date.now();

  try {
    let result: { text: string; usage: AIUsage; model: string };

    switch (provider) {
      case "claude":
        result = await callClaudeVisionWithUsage(apiKey, systemPrompt, message, opts);
        break;
      case "gemini":
        result = await callGeminiVisionWithUsage(apiKey, systemPrompt, message, opts);
        break;
      case "groq":
      case "deepseek":
        // No vision support — fall back to text-only (logs via callAI itself).
        return callAI(
          apiKey,
          systemPrompt,
          [{ role: "user", content: `${message.text}\n\n(Screenshot was captured but your AI provider does not support vision. Analysis is text-only.)` }],
          opts
        );
      default:
        result = await callOpenAICompatVisionWithUsage(
          apiKey,
          systemPrompt,
          message,
          opts,
          provider === "grok" ? "https://api.x.ai/v1" : "https://api.openai.com/v1"
        );
    }

    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens").then(({ logAICall }) => {
        logAICall({
          userId: opts.log!.userId,
          projectId: opts.log!.projectId,
          alertId: opts.log!.alertId,
          remediationSessionId: opts.log!.remediationSessionId,
          feature: opts.log!.feature,
          provider,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          isPlatformKey: opts.log!.isPlatformKey ?? false,
          reservedPlatformCents: opts.log!.reservedPlatformCents ?? 0,
          durationMs: Date.now() - t0,
          // [VISION] marker tells the replay parser to skip — vision calls
          // can't be replayed without the original screenshots, which we
          // intentionally don't persist.
          prompt: `[VISION]\n[SYSTEM]\n${systemPrompt}\n---\n[USER]\n${message.text}`,
          response: result.text,
          ...telemetry,
        });
      }).catch(() => {});
    }

    return result.text;
  } catch (err) {
    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens").then(({ logAICall }) => {
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
      }).catch(() => {});
    }
    throw err;
  }
}

// ── Tool Use (Agentic Loop) — Multi-Provider ───────────────────────────────
//
// All providers normalize to the same ToolUseResponse format.
// The agentic loop in agentic-loop.ts doesn't know which provider it's using.
//
// Provider adapters:
//   Claude    → tool_use content blocks (native, best quality)
//   OpenAI    → function_calling with tool_calls array
//   Grok      → OpenAI-compatible function_calling
//   DeepSeek  → OpenAI-compatible function_calling
//   Groq      → OpenAI-compatible function_calling
//   Gemini    → falls back to text-only (function calling schema is different)

/** Opts for callAIWithTools — accepts optional log context for InariLens. */
export interface CallAIWithToolsOpts {
  maxTokens?: number;
  model?: string;
  timeout?: number;
  provider?: AIProvider;
  /** When set, auto-logs usage + cost + prompt/response per turn to InariLens. */
  log?: AILogContext;

  // ── Responses API fields (GPT-5.x family only) ───────────────────────────
  /**
   * Raw `output` array from the previous turn's response. When we run with
   * `store: false` (the default, for privacy), OpenAI doesn't persist
   * server-side state, so `previous_response_id` doesn't work. Instead we
   * forward the prior turn's output items (reasoning + function_call) back
   * in the next turn's input so reasoning context survives. OpenAI's
   * automatic prompt caching still gives us a prefix-match win without
   * the retention tradeoff of store:true.
   */
  priorOutput?: Array<Record<string, unknown>>;
  /**
   * Reasoning budget for this specific turn. See effortForPhase() in
   * openai-config.ts for the standard mapping. Ignored on non-reasoning
   * models.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /**
   * Enables strict JSON schema compliance on tool calls. Use for terminal
   * tools like `submit_fix` where malformed output is fatal. Mutually
   * exclusive with `parallelToolCalls: true`.
   */
  strict?: boolean;
  /**
   * Forces a specific tool on the next turn. Useful for the final commit
   * turn of a remediation ("you MUST call submit_fix now").
   */
  toolChoice?: "auto" | "required" | { type: "function"; name: string };
  /**
   * Allow the model to call multiple tools in one turn. Default true for
   * exploration (batch read/grep); switch to false during write phase to
   * avoid races.
   */
  parallelToolCalls?: boolean;
}

/**
 * Call an AI provider with tool definitions and return structured content blocks.
 * Supports the agentic loop: tool_use → execute → tool_result → repeat.
 *
 * All providers return the same ToolUseResponse format — the adapter handles translation.
 * Gemini falls back to text-only (its function calling format is incompatible).
 *
 * If `opts.log` is set, each turn is recorded to InariLens — so a 15-turn
 * remediation produces 15 rows, one per model round-trip. The response field
 * summarizes what the model did: either the final text or a `[tool_use: ...]`
 * marker listing the tools it called.
 */
export async function callAIWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: CallAIWithToolsOpts = {}
): Promise<ToolUseResponse> {
  const provider = opts.provider ?? detectProvider(apiKey);
  const t0 = Date.now();

  try {
    let internal: ToolUseResponse & { usage: AIUsage; model: string };

    switch (provider) {
      case "claude":
        internal = await callClaudeWithTools(apiKey, systemPrompt, messages, tools, opts);
        break;
      case "openai": {
        // GPT-5.x reasoning models MUST use Responses API — Chat Completions
        // silently drops reasoning context between tool calls, which
        // degrades performance ~30% (Cursor's measurement) and loses
        // prompt cache wins.
        const { isGPT5Family } = await import("./openai-config");
        const model = opts.model ?? "gpt-4o-mini";
        if (isGPT5Family(model)) {
          internal = await callOpenAIResponsesWithTools(apiKey, systemPrompt, messages, tools, opts);
        } else {
          internal = await callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.openai.com/v1");
        }
        break;
      }
      case "grok":
        internal = await callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.x.ai/v1");
        break;
      case "deepseek":
        internal = await callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.deepseek.com/v1");
        break;
      case "groq":
        internal = await callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.groq.com/openai/v1");
        break;
      case "gemini": {
        // Gemini function calling has an incompatible schema — fall back to text-only
        const geminiResp = await callGeminiWithUsage(apiKey, systemPrompt, flattenMessages(messages), opts);
        internal = {
          stopReason: "end_turn",
          text: geminiResp.text,
          usage: geminiResp.usage,
          model: geminiResp.model,
        };
        break;
      }
    }

    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens").then(({ logAICall, serializePrompt }) => {
        // For tool_use turns there's no final text — record a marker listing
        // which tools were called so the admin UI shows what the model did.
        const responseText =
          internal.stopReason === "end_turn"
            ? internal.text
            : `[tool_use] ${internal.content
                .filter((b): b is ToolUseBlock => b.type === "tool_use")
                .map((b) => `${b.name}(${JSON.stringify(b.input).slice(0, 2000)})`)
                .join("\n")}`;

        logAICall({
          userId: opts.log!.userId,
          projectId: opts.log!.projectId,
          alertId: opts.log!.alertId,
          remediationSessionId: opts.log!.remediationSessionId,
          feature: opts.log!.feature,
          provider,
          model: internal.model,
          inputTokens: internal.usage.inputTokens,
          outputTokens: internal.usage.outputTokens,
          cachedInputTokens: internal.usage.cachedInputTokens,
          isPlatformKey: opts.log!.isPlatformKey ?? false,
          reservedPlatformCents: opts.log!.reservedPlatformCents ?? 0,
          durationMs: Date.now() - t0,
          prompt: serializePrompt(systemPrompt, messages),
          response: responseText,
          ...telemetry,
        });
      }).catch(() => {});
    }

    // Strip internal usage fields before returning to caller. Preserve
    // responseId + priorOutput so callers can thread next turn: pass
    // priorOutput back as opts.priorOutput to keep reasoning continuity.
    if (internal.stopReason === "end_turn") {
      return {
        stopReason: "end_turn",
        text: internal.text,
        responseId: internal.responseId,
        priorOutput: internal.priorOutput,
      };
    }
    return {
      stopReason: "tool_use",
      content: internal.content,
      responseId: internal.responseId,
      priorOutput: internal.priorOutput,
    };
  } catch (err) {
    if (opts.log) {
      const telemetry = pickTelemetryFields(opts.log);
      import("./lens").then(({ logAICall, serializePrompt }) => {
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
      }).catch(() => {});
    }
    throw err;
  }
}

// ── Claude Tool Use ─────────────────────────────────────────────────────────

async function callClaudeWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<ToolUseResponse & { usage: AIUsage; model: string }> {
  const model = opts.model ?? "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 60000),
  });

  if (!res.ok) throw new Error(`Claude API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const stopReason = data.stop_reason as string;
  const content = data.content as ContentBlock[];
  const rawUsage = data.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
    | undefined;
  const usage: AIUsage = {
    inputTokens: (rawUsage?.input_tokens ?? 0) + (rawUsage?.cache_read_input_tokens ?? 0),
    outputTokens: rawUsage?.output_tokens ?? 0,
    cachedInputTokens: rawUsage?.cache_read_input_tokens ?? 0,
  };

  if (stopReason === "tool_use") {
    return { stopReason: "tool_use", content, usage, model };
  }

  const textBlock = content.find((c) => c.type === "text") as TextBlock | undefined;
  return { stopReason: "end_turn", text: textBlock?.text ?? "", usage, model };
}

// ── OpenAI-Compatible Tool Use (OpenAI, Grok, DeepSeek, Groq) ──────────────

/**
 * Translates between the unified AIMessage format (Claude-style content blocks)
 * and OpenAI's message format (role: "tool" with tool_call_id).
 *
 * Claude format:
 *   assistant: [{ type: "tool_use", id, name, input }]
 *   user: [{ type: "tool_result", tool_use_id, content }]
 *
 * OpenAI format:
 *   assistant: { tool_calls: [{ id, type: "function", function: { name, arguments } }] }
 *   tool: { role: "tool", tool_call_id, content }
 */
function translateMessagesForOpenAI(
  systemPrompt: string,
  messages: AIMessage[]
): { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[] {
  const result: { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Content blocks array — translate based on block types
    const blocks = msg.content as ContentBlock[];
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    const textBlocks = blocks.filter((b): b is TextBlock => b.type === "text");

    if (toolUses.length > 0) {
      // Assistant message with tool calls
      const text = textBlocks.map((b) => b.text).join("\n") || null;
      result.push({
        role: "assistant",
        content: text,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        })),
      });
    } else if (toolResults.length > 0) {
      // Tool result messages — each becomes a separate "tool" role message
      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }
    } else if (textBlocks.length > 0) {
      result.push({ role: msg.role, content: textBlocks.map((b) => b.text).join("\n") });
    }
  }

  return result;
}

async function callOpenAICompatWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: { maxTokens?: number; model?: string; timeout?: number },
  baseUrl: string
): Promise<ToolUseResponse & { usage: AIUsage; model: string }> {
  const model = opts.model ?? "gpt-4o";
  // Translate tools to OpenAI format
  const openaiTools = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  // Translate messages from Claude format to OpenAI format
  const openaiMessages = translateMessagesForOpenAI(systemPrompt, messages);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(baseUrl.includes("api.openai.com")
        ? { max_completion_tokens: opts.maxTokens ?? 4096 }
        : { max_tokens: opts.maxTokens ?? 4096 }),
      tools: openaiTools,
      messages: openaiMessages,
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 60000),
  });

  if (!res.ok) throw new Error(`API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const choice = (data.choices as { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[])?.[0];

  if (!choice) throw new Error("No response from API");

  const rawUsage = data.usage as
    | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
    | undefined;
  const usage: AIUsage = {
    inputTokens: rawUsage?.prompt_tokens ?? 0,
    outputTokens: rawUsage?.completion_tokens ?? 0,
    cachedInputTokens: rawUsage?.prompt_tokens_details?.cached_tokens ?? 0,
  };

  const toolCalls = choice.message.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    // Translate OpenAI tool_calls to Claude tool_use content blocks
    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    for (const tc of toolCalls) {
      let parsedInput: Record<string, unknown>;
      try {
        parsedInput = JSON.parse(tc.function.arguments);
      } catch {
        parsedInput = { raw: tc.function.arguments };
      }

      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }

    return { stopReason: "tool_use", content, usage, model };
  }

  // No tool calls — text response
  return { stopReason: "end_turn", text: choice.message.content ?? "", usage, model };
}

// ── OpenAI Responses API (GPT-5.x) ─────────────────────────────────────────

/**
 * Adapter for OpenAI's Responses API. Used automatically for any gpt-5.x
 * model via the router in callAIWithTools.
 *
 * Key differences vs Chat Completions:
 *   - Input is a flat array of ITEMS (messages, function_call, function_call_output).
 *   - Tools are flat: { type:"function", name, description, parameters, strict? }
 *     (no nested `function` wrapper).
 *   - Reasoning state survives across turns via `previous_response_id` OR
 *     via `include: ["reasoning.encrypted_content"]` with store:false.
 *   - max_tokens → max_output_tokens. Reasoning tokens count against this budget.
 *   - Tool results come back as items with type "function_call" containing
 *     { call_id, name, arguments }.
 */
async function callOpenAIResponsesWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: CallAIWithToolsOpts
): Promise<ToolUseResponse & { usage: AIUsage; model: string; responseId: string }> {
  const model = opts.model ?? "gpt-5.4-mini";

  // Lazy-load provider options so non-OpenAI paths don't pay for the import.
  const { getOpenAIProviderOptions } = await import("./openai-config");
  const providerOpts = getOpenAIProviderOptions(model);

  // Build tools in Responses-API shape (flat, not nested under `function`).
  // Strict mode enforces JSON schema compliance; enable only when the caller
  // requests it (terminal tools like submit_fix).
  const responsesTools = tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
    strict: opts.strict ?? false,
  }));

  // Build input with prior output spliced in where the last assistant
  // message sits — that preserves function_call + reasoning pairing across
  // turns. See buildResponsesInput below for the full strategy.
  const input = buildResponsesInput(messages, opts.priorOutput);

  const body: Record<string, unknown> = {
    model,
    input,
    tools: responsesTools,
    tool_choice: opts.toolChoice ?? "auto",
    parallel_tool_calls: opts.parallelToolCalls ?? (opts.strict ? false : true),
    max_output_tokens: opts.maxTokens ?? 4096,
    store: providerOpts.store,
    include: providerOpts.include,
    // Always send the system prompt. Automatic prompt caching matches on
    // the full prefix, so repeating a stable system prompt is effectively
    // free after the first cache hit.
    instructions: systemPrompt,
  };

  // gpt-5.4 verbosity clamp — `text.verbosity` in Responses API (not `textVerbosity`).
  if (providerOpts.textVerbosity) {
    body.text = { verbosity: providerOpts.textVerbosity };
  }

  // Reasoning budget. `reasoning_summary: "auto"` gives us a short human-readable
  // summary of what the model thought about, streamable via the reasoning event.
  if (opts.reasoningEffort) {
    body.reasoning = { effort: opts.reasoningEffort, summary: "auto" };
  }

  const res = await fetch(`https://api.openai.com/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // Reasoning models can run longer — give them headroom. Callers can
    // still override via opts.timeout.
    signal: AbortSignal.timeout(opts.timeout ?? 120_000),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    throw new Error(`OpenAI Responses API error (${res.status}): ${errText}`);
  }

  const data = await safeJson(res);
  const responseId = data.id as string;

  // Usage: `input_tokens_details.cached_tokens` is where automatic prompt
  // caching shows up. Output tokens include reasoning tokens (billable).
  const rawUsage = data.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined;
  const usage: AIUsage = {
    inputTokens: rawUsage?.input_tokens ?? 0,
    outputTokens: rawUsage?.output_tokens ?? 0,
    cachedInputTokens: rawUsage?.input_tokens_details?.cached_tokens ?? 0,
  };

  // Output parsing. The Responses API returns an array of `output` items.
  // We care about `function_call` (tool invocation) and `message` (final
  // assistant text). We ALSO capture the full output array so the caller
  // can forward reasoning + function_call items back on the next turn —
  // that's how reasoning continuity works in store:false mode.
  const output = (data.output as Array<Record<string, unknown>>) ?? [];
  const priorOutput = output;

  const functionCalls = output.filter((o) => o.type === "function_call") as Array<{
    type: "function_call";
    call_id: string;
    name: string;
    arguments: string;
  }>;

  if (functionCalls.length > 0) {
    const content: ContentBlock[] = functionCalls.map((fc) => {
      let parsedInput: Record<string, unknown>;
      try {
        parsedInput = JSON.parse(fc.arguments);
      } catch {
        parsedInput = { raw: fc.arguments };
      }
      return {
        type: "tool_use" as const,
        // call_id is the Responses API equivalent of Claude's tool_use id.
        // Callers (agentic-loop, container-agent) already reference this
        // field generically as `id`, so we preserve the alias.
        id: fc.call_id,
        name: fc.name,
        input: parsedInput,
      };
    });
    return { stopReason: "tool_use", content, usage, model, responseId, priorOutput };
  }

  // No tool calls — extract the final assistant text. Message items contain
  // a content array of { type: "output_text", text: "..." } parts.
  const messageItem = output.find((o) => o.type === "message") as
    | { content?: Array<{ type: string; text?: string }> }
    | undefined;
  const text =
    messageItem?.content?.find((p) => p.type === "output_text")?.text ?? "";

  return { stopReason: "end_turn", text, usage, model, responseId, priorOutput };
}

/**
 * Build the full Responses API input.
 *
 * Strategy (store:false / stateless mode):
 *   1. Walk messages chronologically.
 *   2. When we hit the last assistant message that corresponds to priorOutput,
 *      splice the priorOutput items in place of the assistant content-blocks
 *      form (reasoning items + function_call items from the actual response).
 *   3. After the priorOutput, emit function_call_output items for each
 *      tool_result in the subsequent user message.
 *   4. Any messages BEFORE the priorOutput splice point stay as simple
 *      message items — they're context but aren't tied to a specific
 *      response's reasoning.
 *
 * When priorOutput is undefined (first turn), every message becomes a
 * simple `message` item.
 *
 * Why this shape: in store:false mode, `function_call` and `function_call_output`
 * items must be properly paired by `call_id` OR OpenAI returns 400. Reasoning
 * items with `encrypted_content` must also stay paired with their response —
 * you can't synthesize them from Claude-shaped content blocks.
 */
export function buildResponsesInput(
  messages: AIMessage[],
  priorOutput?: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  // Find the last assistant message — priorOutput replaces its content.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLastAssistant = i === lastAssistantIdx;

    // Replace the last assistant message with priorOutput verbatim so
    // reasoning.encrypted_content + function_call items stay paired.
    if (isLastAssistant && priorOutput && priorOutput.length > 0) {
      items.push(...priorOutput);
      continue;
    }

    // Assistant message from an earlier turn with tool_use blocks: emit
    // one `function_call` item per tool_use so downstream
    // `function_call_output` items still resolve by call_id. Without this
    // the Responses API 400s with "No tool call found for function call
    // output with call_id …" after the second turn of a multi-tool loop.
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const blocks = m.content as ContentBlock[];
      const hasToolUse = blocks.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        // Emit any plain text blocks as a separate message first (rare,
        // but preserves reasoning-ish narration if the model produced it).
        const textParts = blocks
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (textParts.length > 0) {
          items.push({ type: "message", role: "assistant", content: textParts });
        }
        for (const b of blocks) {
          if (b.type === "tool_use") {
            const tu = b as ToolUseBlock;
            items.push({
              type: "function_call",
              call_id: tu.id,
              name: tu.name,
              arguments: JSON.stringify(tu.input ?? {}),
            });
          }
        }
        continue;
      }
    }

    // User message with content-block form = tool_result turn. Expand each
    // tool_result into a function_call_output item keyed by call_id.
    if (m.role === "user" && Array.isArray(m.content)) {
      const blocks = m.content as ContentBlock[];
      const toolResults = blocks.filter((b) => b.type === "tool_result") as ToolResultBlock[];
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          items.push({
            type: "function_call_output",
            call_id: tr.tool_use_id,
            output: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
        continue;
      }
    }

    items.push(toResponsesItem(m));
  }

  return items;
}

/**
 * Convert a single Claude-shaped message to a Responses API input item.
 * For string content it's a plain message; for content blocks we emit the
 * appropriate item type per block.
 */
function toResponsesItem(m: AIMessage): Record<string, unknown> {
  if (typeof m.content === "string") {
    return { type: "message", role: m.role, content: m.content };
  }
  // Content-block form: for user messages with tool_result blocks, the
  // caller should use buildIncrementalResponsesInput which splits them into
  // function_call_output items. For the FIRST turn (where this path runs),
  // content blocks are rare but we fall back to flattened text.
  const flat = (m.content as ContentBlock[])
    .map((b) => {
      if (b.type === "text") return (b as TextBlock).text;
      if (b.type === "tool_use") return `[tool_use ${(b as ToolUseBlock).name}]`;
      if (b.type === "tool_result") return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      return "";
    })
    .join("\n");
  return { type: "message", role: m.role, content: flat };
}

// ── Message Utilities ───────────────────────────────────────────────────────

/** Flatten content block messages to plain text strings for providers that don't support tool use. */
function flattenMessages(messages: AIMessage[]): AIMessage[] {
  return messages.map((m) => ({
    ...m,
    content: typeof m.content === "string"
      ? m.content
      : (m.content as ContentBlock[]).filter((b) => b.type === "text").map((b) => (b as TextBlock).text).join("\n"),
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Safe JSON parse that handles HTML error pages and malformed responses */
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ── Provider implementations ─────────────────────────────────────────────────

async function callClaude(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<string> {
  const response = await callClaudeWithUsage(apiKey, system, messages, opts);
  return response.text;
}

async function callClaudeWithUsage(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: CallAIOpts
): Promise<AIResponse> {
  const model = opts.model ?? "claude-sonnet-4-6";
  const res = await fetch(`https://api.anthropic.com/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) throw new Error(`Claude API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const text = (data.content as { text: string }[])?.[0]?.text ?? "";
  const usage = data.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;

  return {
    text,
    usage: {
      // Claude's input_tokens is the NON-cached portion. Cached tokens are
      // reported separately. Total input for cost = fresh + cache_read.
      inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    },
    model,
    provider: "claude",
  };
}

/** Shared implementation for OpenAI, Grok (xAI), and DeepSeek (all OpenAI-compatible). */
async function callOpenAICompat(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number },
  baseUrl: string
): Promise<string> {
  const response = await callOpenAICompatWithUsage(apiKey, system, messages, opts, baseUrl, "openai");
  return response.text;
}

async function callOpenAICompatWithUsage(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: CallAIOpts,
  baseUrl: string,
  provider: AIProvider
): Promise<AIResponse> {
  const model = opts.model ?? "gpt-4o-mini";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      // OpenAI newer models (gpt-4o+) require max_completion_tokens; other
      // OpenAI-compatible providers (Grok, DeepSeek, Groq) still use max_tokens.
      ...(provider === "openai"
        ? { max_completion_tokens: opts.maxTokens ?? 1024 }
        : { max_tokens: opts.maxTokens ?? 1024 }),
      messages: [{ role: "system", content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) throw new Error(`API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const text = ((data.choices as { message: { content: string } }[])?.[0]?.message?.content as string) ?? "";
  const usage = data.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined;

  return {
    text,
    usage: {
      // OpenAI's prompt_tokens INCLUDES cached tokens (they're part of the
      // total input). cached_tokens is the discounted portion.
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model,
    provider,
  };
}

async function callGemini(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<string> {
  const response = await callGeminiWithUsage(apiKey, system, messages, opts);
  return response.text;
}

async function callGeminiWithUsage(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<AIResponse> {
  const model = opts.model ?? "gemini-1.5-flash";
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error("Invalid Gemini model name");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 1024 },
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const text = ((data.candidates as { content: { parts: { text: string }[] } }[])?.[0]?.content?.parts?.[0]?.text as string) ?? "";
  const usage = data.usageMetadata as
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      }
    | undefined;

  // Need to return early with the usage object — the original function had
  // more code after this point that we preserve in the wrapper below.
  return {
    text,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
    },
    model,
    provider: "gemini",
  };
}

// ── Vision implementations ──────────────────────────────────────────────────

async function callClaudeVisionWithUsage(
  apiKey: string,
  system: string,
  msg: AIVisionMessage,
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<{ text: string; usage: AIUsage; model: string }> {
  const model = opts.model ?? "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 512,
      system,
      messages: [{
        role: "user",
        content: [
          ...(msg.beforeImageBase64 ? [
            { type: "text", text: "BEFORE (broken state):" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: msg.beforeImageBase64 } },
            { type: "text", text: "AFTER (after fix applied):" },
          ] : []),
          { type: "image", source: { type: "base64", media_type: "image/png", data: msg.imageBase64 } },
          { type: "text", text: msg.text },
        ],
      }],
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) throw new Error(`Claude Vision API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await safeJson(res);
  const text = (data.content as { text: string }[])?.[0]?.text ?? "";
  const usage = data.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
    | undefined;
  return {
    text,
    usage: {
      inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    },
    model,
  };
}

async function callOpenAICompatVisionWithUsage(
  apiKey: string,
  system: string,
  msg: AIVisionMessage,
  opts: { maxTokens?: number; model?: string; timeout?: number },
  baseUrl: string
): Promise<{ text: string; usage: AIUsage; model: string }> {
  const model = opts.model ?? "gpt-4o-mini";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(baseUrl.includes("api.openai.com")
        ? { max_completion_tokens: opts.maxTokens ?? 512 }
        : { max_tokens: opts.maxTokens ?? 512 }),
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            ...(msg.beforeImageBase64 ? [
              { type: "text", text: "BEFORE (broken state):" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${msg.beforeImageBase64}` } },
              { type: "text", text: "AFTER (after fix applied):" },
            ] : []),
            { type: "image_url", image_url: { url: `data:image/png;base64,${msg.imageBase64}` } },
            { type: "text", text: msg.text },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) throw new Error(`Vision API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await safeJson(res);
  const text = ((data.choices as { message: { content: string } }[])?.[0]?.message?.content as string) ?? "";
  const usage = data.usage as
    | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
    | undefined;
  return {
    text,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model,
  };
}

async function callGeminiVisionWithUsage(
  apiKey: string,
  system: string,
  msg: AIVisionMessage,
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<{ text: string; usage: AIUsage; model: string }> {
  const model = opts.model ?? "gemini-1.5-flash";
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error("Invalid Gemini model name");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{
        role: "user",
        parts: [
          ...(msg.beforeImageBase64 ? [
            { text: "BEFORE (broken state):" },
            { inlineData: { mimeType: "image/png", data: msg.beforeImageBase64 } },
            { text: "AFTER (after fix applied):" },
          ] : []),
          { inlineData: { mimeType: "image/png", data: msg.imageBase64 } },
          { text: msg.text },
        ],
      }],
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 512 },
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) throw new Error(`Gemini Vision API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await safeJson(res);
  const text = ((data.candidates as { content: { parts: { text: string }[] } }[])?.[0]?.content?.parts?.[0]?.text as string) ?? "";
  const usage = data.usageMetadata as
    | { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }
    | undefined;
  return {
    text,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
    },
    model,
  };
}
