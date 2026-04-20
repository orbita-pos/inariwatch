/**
 * Unified AI client — Claude, OpenAI, Grok, DeepSeek, Gemini, Groq.
 * Grok, DeepSeek, and Groq are OpenAI-compatible (different base URL).
 * Gemini uses its own REST API.
 */

import type { LensFeature } from "./lens";

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
  | { stopReason: "tool_use"; content: ContentBlock[] }
  | { stopReason: "end_turn"; text: string };

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
 */
export interface AILogContext {
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
        });
      }).catch(() => {});
    }
    return response.text;
  } catch (err) {
    if (opts.log) {
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
        });
      }).catch(() => {});
    }

    return result.text;
  } catch (err) {
    if (opts.log) {
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
      case "openai":
        internal = await callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.openai.com/v1");
        break;
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
      import("./lens").then(({ logAICall, serializePrompt }) => {
        // For tool_use turns there's no final text — record a marker listing
        // which tools were called so the admin UI shows what the model did.
        const responseText =
          internal.stopReason === "end_turn"
            ? internal.text
            : `[tool_use] ${internal.content
                .filter((b): b is ToolUseBlock => b.type === "tool_use")
                .map((b) => `${b.name}(${JSON.stringify(b.input).slice(0, 200)})`)
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
        });
      }).catch(() => {});
    }

    // Strip internal usage fields before returning to caller
    if (internal.stopReason === "end_turn") {
      return { stopReason: "end_turn", text: internal.text };
    }
    return { stopReason: "tool_use", content: internal.content };
  } catch (err) {
    if (opts.log) {
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
