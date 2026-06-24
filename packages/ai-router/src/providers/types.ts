// Shared provider-adapter types.
//
// These mirror the existing web/lib/ai/client.ts public types verbatim — the
// router is a refactor, not a redesign. Future phases may expand the
// interface (streaming, structured output) but Phase 1 freezes at parity.

import type { AIProvider } from "../rules";

export type AIMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type AIVisionMessage = {
  role: "user";
  text: string;
  imageBase64: string;
  beforeImageBase64?: string;
};

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type TextBlock = { type: "text"; text: string };
export type ContentBlock = ToolUseBlock | ToolResultBlock | TextBlock;

export type ToolUseResponse =
  | {
      stopReason: "tool_use";
      content: ContentBlock[];
      responseId?: string;
      priorOutput?: Array<Record<string, unknown>>;
    }
  | {
      stopReason: "end_turn";
      text: string;
      responseId?: string;
      priorOutput?: Array<Record<string, unknown>>;
    };

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AIResponse {
  text: string;
  usage: AIUsage;
  model: string;
  provider: AIProvider;
}

export interface CompleteOpts {
  apiKey: string;
  systemPrompt: string;
  messages: AIMessage[];
  maxTokens?: number;
  model?: string;
  timeout?: number;
  /**
   * Sampling temperature, 0..2. Forwarded to providers that accept it
   * (OpenAI-compatible). Anthropic + Gemini map approximately. Omit to use
   * the provider's default.
   */
  temperature?: number;
  /**
   * Force JSON output. Currently honored by OpenAI-compatible providers via
   * `response_format: { type: "json_object" }`. Other providers ignore it.
   */
  jsonMode?: boolean;
  /**
   * Enable Qwen3 chain-of-thought reasoning on Together AI.
   * When set, injects `thinking: { type: "enabled", budget_tokens: N }` into
   * the request. Only activated when cfg.provider === "together"; silently
   * ignored by all other providers. Adds latency (~2-5s) but measurably
   * improves quality on complex analysis tasks (self-review, chat).
   */
  thinkingBudget?: number;
}

export interface ToolUseOpts extends CompleteOpts {
  tools: ToolDefinition[];
  /** Responses-API forwarding for GPT-5.x (web's openai-config.ts). */
  priorOutput?: Array<Record<string, unknown>>;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  strict?: boolean;
  toolChoice?: "auto" | "required" | { type: "function"; name: string };
  parallelToolCalls?: boolean;
}

// ── Streaming (v0.3 S2.5) ───────────────────────────────────────────────────
//
// Providers that natively support server-sent streaming implement
// `streamComplete()`. Providers that do not throw `STREAM_NOT_SUPPORTED`
// inside their adapter; dispatchStream() catches the sentinel and falls
// back to a single-chunk emit from `complete()`.

export interface StreamCompleteOpts extends CompleteOpts {
  /** Optional — forwarded to fetch() so the caller can interrupt mid-stream. */
  signal?: AbortSignal;
  /**
   * Function-calling catalog. When non-empty, the OpenAI-compatible body
   * grows a `tools: [{type:"function", function:{...}}]` array and the
   * stream may emit `{type:"toolCall"}` deltas in addition to text deltas.
   * Surfaces left this empty kept the legacy text-only contract; populated
   * for desktop's Inari Live chat (S6 tool-use). Other providers ignore
   * the field for now.
   */
  tools?: ToolDefinition[];
}

export type StreamDelta = {
  /** Text token(s) emitted by the provider. May be empty for keep-alive frames. */
  delta: string;
};

/**
 * Streaming-time fragment of an LLM-emitted tool call. Mirrors the Rust
 * `ToolCallDelta` shape — the proxy SSE wire reuses field names so the
 * Rust client can deserialize each chunk's `tool_call` payload directly.
 *
 * - `index` — OpenAI's `tool_calls[i].index`. Stable across deltas for
 *   the same tool call; multiple parallel calls in one assistant
 *   message increment this.
 * - `id` — provider-issued call id. Set on the first delta that carries
 *   it; absent on subsequent argument fragments.
 * - `name` — function name. Set once on the first delta that announces
 *   the call.
 * - `argsDelta` — partial JSON arguments string. Concatenate per
 *   `index` to assemble the full payload.
 */
export interface StreamToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argsDelta: string;
}

export type StreamFinal = {
  /** Final accumulated usage. Some providers emit per-message, others omit; default to zeros. */
  usage: AIUsage;
  model: string;
  /**
   * Reason the stream closed. OpenAI-compatible providers emit this on
   * the chunk that carries `finish_reason`. Common values:
   * `"stop"` (normal completion), `"tool_calls"` (the model emitted
   * function calls and is waiting for tool results), `"length"`
   * (max_tokens hit), `"content_filter"`. `undefined` when the provider
   * did not surface one (kept-alive close, network-level cutoff).
   */
  finishReason?: string;
};

export const STREAM_NOT_SUPPORTED = "stream-not-supported";

/**
 * Adapter-level streaming contract. Yields zero or more text deltas
 * and/or tool-call deltas, then exactly one final marker carrying usage,
 * model, and an optional finish_reason. Errors mid-stream propagate as
 * thrown Errors and the dispatcher emits `{ delta: "", done: true }`
 * after rethrowing.
 */
export type StreamCompleteResult = AsyncGenerator<
  | { type: "delta"; delta: string }
  | { type: "toolCall"; toolCall: StreamToolCallDelta }
  | { type: "final"; final: StreamFinal },
  void,
  void
>;

export interface VisionOpts {
  apiKey: string;
  systemPrompt: string;
  message: AIVisionMessage;
  maxTokens?: number;
  model?: string;
  timeout?: number;
}

export type ToolUseProviderResult = ToolUseResponse & {
  usage: AIUsage;
  model: string;
  responseId?: string;
};

export type VisionProviderResult = {
  text: string;
  usage: AIUsage;
  model: string;
};

// ── Validate key (v0.3 S2.5) ────────────────────────────────────────────────
//
// `validateKey()` does NOT make AI inferences — it pings the provider's
// list-models endpoint to confirm the key is live before the user saves it.
// Lives on the provider adapter so the lockdown rule allows the raw fetch.

export interface ValidateKeyResult {
  valid: boolean;
  error?: string;
  /** Best-effort list of model ids the key has access to. Empty when unsupported. */
  modelsAvailable?: string[];
}

/**
 * Safe JSON parse that surfaces HTML error pages with the original status
 * code so callers can include the response in their error chain.
 */
export async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `API returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }
}
