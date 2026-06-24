// Shared OpenAI-compatible adapter.
//
// Used by openai.ts (Chat Completions path), grok.ts, groq.ts, and deepseek.ts.
// Any provider whose endpoint speaks the `POST /v1/chat/completions` shape
// can hand off to runComplete / runWithTools / runVision below.
//
// Lives inside `providers/` so the lockdown rule allows the raw fetch.
// Files outside this directory must NOT import this module directly — they
// must go through dispatch().

import type { AIProvider } from "../rules";
import {
  type AIMessage,
  type ContentBlock,
  type CompleteOpts,
  type StreamCompleteOpts,
  type StreamCompleteResult,
  type ToolDefinition,
  type ToolResultBlock,
  type ToolUseBlock,
  type TextBlock,
  type ToolUseOpts,
  type AIResponse,
  type AIUsage,
  type ToolUseProviderResult,
  type ValidateKeyResult,
  type VisionOpts,
  type VisionProviderResult,
  safeJson,
} from "./types";

interface CompatCfg {
  baseUrl: string;
  provider: AIProvider;
  defaultModel: string;
}

/**
 * Together AI's `enable_thinking` chat template flag is only honored by the
 * Qwen3 reasoning family. Other Together-hosted models accept the field
 * silently but produce no chain-of-thought. Mirror of
 * `web/lib/ai/together-routing.ts::modelSupportsThinking` — duplicated here
 * because this file lives in the `@inariwatch/ai-router` package and cannot
 * reach into `web/`.
 */
const THINKING_SUPPORTED_PREFIXES = [
  "Qwen/Qwen3-235B",
  "Qwen/Qwen3.6",
  "Qwen/Qwen3-Coder",
];
function modelSupportsThinking(model: string): boolean {
  return THINKING_SUPPORTED_PREFIXES.some((p) => model.startsWith(p));
}

// ── Tool schema sanitization ────────────────────────────────────────────────
//
// OpenAI strict-mode + Together's edge validator (which runs even when
// `strict: true` is NOT set on newer models — GPT-5 family, Qwen-via-
// Together) reject various JSON Schema constructs. We apply the strict
// subset proactively to every tool parameters schema before serialization,
// recursively. The rules below are the intersection of "OpenAI strict
// accepts" and "Together's edge validator passes":
//
//   - `oneOf`/`allOf`/`not` are stripped at any depth.
//   - `anyOf`/`enum` are stripped only at the root (nested `anyOf` is
//     supported — used for nullables — and nested `enum` is supported).
//   - Validation keywords listed as unsupported by strict mode are stripped
//     everywhere: `format`, `pattern`, `min/maxLength`, `min/max`,
//     `min/maxItems`, `uniqueItems`, `multipleOf`, `min/maxProperties`.
//   - Schema metadata is stripped: `$schema`, `$id`, `$ref`, `title`,
//     `default`, `examples`.
//   - Tuple form `items: [...]` degrades to `items: { anyOf: [...] }`
//     (homogeneous), and `prefixItems` is dropped.
//   - Missing `items` on any `type: "array"` is injected as `items: {}`
//     (the field is mandatory; empty schema means "any value").
//   - Missing `type` at the root defaults to `"object"`.
//
// Property descriptions, `required`, and nested enums are preserved so the
// model still has guidance. Each tool's `execute()` re-validates args at
// runtime, so stripping pre-call validation doesn't sacrifice safety —
// only loses some model-side hinting, which the property `description`s
// and the function-level prose compensate for.
const STRIP_VALIDATION_KEYWORDS = new Set([
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "multipleOf",
  "default",
  "examples",
  "$schema",
  "$id",
  "$ref",
  "title",
]);
const ROOT_FORBIDDEN_COMPOSITION = new Set([
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "enum",
]);
const NESTED_FORBIDDEN_COMPOSITION = new Set(["oneOf", "allOf", "not"]);

function sanitizeNode(node: unknown, isRoot: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => sanitizeNode(n, false));
  }
  if (node === null || typeof node !== "object") return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_VALIDATION_KEYWORDS.has(k)) continue;
    if (isRoot && ROOT_FORBIDDEN_COMPOSITION.has(k)) continue;
    if (!isRoot && NESTED_FORBIDDEN_COMPOSITION.has(k)) continue;

    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = sanitizeNode(pv, false);
      }
      out[k] = props;
    } else if (k === "items") {
      // Tuple form (`items: [...]`) is rejected — degrade to homogeneous.
      if (Array.isArray(v)) {
        out[k] = { anyOf: v.map((n) => sanitizeNode(n, false)) };
      } else {
        out[k] = sanitizeNode(v, false);
      }
    } else if (k === "anyOf" && Array.isArray(v)) {
      out[k] = v.map((n) => sanitizeNode(n, false));
    } else if (
      k === "patternProperties" &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      // patternProperties is `{ <regex>: <schema>, ... }` — each value is
      // itself a schema and must be sanitized, not the dict wrapper.
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = sanitizeNode(pv, false);
      }
      out[k] = props;
    } else if (
      k === "additionalProperties" &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      // additionalProperties: <schema> (boolean form falls through).
      out[k] = sanitizeNode(v, false);
    } else {
      out[k] = v;
    }
  }

  if ("prefixItems" in out) delete out.prefixItems;
  if (out.type === "array" && !("items" in out)) {
    out.items = {};
  }
  if (isRoot && !("type" in out)) {
    out.type = "object";
  }

  return out;
}

/**
 * Sanitize a tool parameters schema to the OpenAI/Together strict-mode
 * subset. See module-level docs above.
 */
export function sanitizeToolSchemaForStrict(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeNode(schema, true) as Record<string, unknown>;
}

/**
 * Per-call tool-name sanitizer. OpenAI + Together require tool function
 * names to match `^[a-zA-Z0-9_-]+$`; our Rust agent registry uses dotted
 * namespaces (`cloud.list_projects`, `comm.send_slack`). On outbound we
 * replace any disallowed character with `-` and remember the mapping; on
 * inbound (model's `tool_calls` echo) we restore the original so the
 * registry lookup hits.
 *
 * Keep one instance per chat call — the map is conversation-scoped so
 * future tool sets with different name shapes don't collide.
 */
export function makeToolNameSanitizer(): {
  sanitize: (name: string) => string;
  restore: (name: string) => string;
} {
  const toolNameMap = new Map<string, string>();
  const sanitize = (n: string): string => {
    const safe = n.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (safe !== n) toolNameMap.set(safe, n);
    return safe;
  };
  const restore = (name: string): string => toolNameMap.get(name) ?? name;
  return { sanitize, restore };
}

export async function runComplete(
  opts: CompleteOpts,
  cfg: CompatCfg,
): Promise<AIResponse> {
  const model = opts.model ?? cfg.defaultModel;
  const isOpenAI = cfg.provider === "openai";
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      // OpenAI's newer models (gpt-4o+) require max_completion_tokens; other
      // OpenAI-compatible providers (Grok, DeepSeek, Groq) still use max_tokens.
      ...(isOpenAI
        ? { max_completion_tokens: opts.maxTokens ?? 1024 }
        : { max_tokens: opts.maxTokens ?? 1024 }),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      // Qwen3 thinking mode (Together AI only). Together exposes thinking via
      // `chat_template_kwargs.enable_thinking` (NOT the Anthropic shape). The
      // thinking budget is implicitly the model's max_tokens — Together's API
      // does not accept a separate `budget_tokens` field. Only emit the flag
      // when the model is in the supported family (Qwen3-235B / Qwen3.6 /
      // Qwen3-Coder); other Together-hosted models silently drop the field.
      ...(opts.thinkingBudget && cfg.provider === "together" && modelSupportsThinking(model)
        ? { chat_template_kwargs: { enable_thinking: true } }
        : {}),
      messages: [{ role: "system", content: opts.systemPrompt }, ...opts.messages],
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30_000),
  });

  if (!res.ok) {
    throw new Error(
      `API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const data = await safeJson(res);
  const text =
    ((data.choices as { message: { content: string } }[])?.[0]?.message
      ?.content as string) ?? "";
  const rawUsage = data.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined;

  return {
    text,
    usage: {
      // OpenAI's prompt_tokens INCLUDES cached tokens; cached_tokens is the
      // discounted portion.
      inputTokens: rawUsage?.prompt_tokens ?? 0,
      outputTokens: rawUsage?.completion_tokens ?? 0,
      cachedInputTokens: rawUsage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model,
    provider: cfg.provider,
  };
}

export async function runWithTools(
  opts: ToolUseOpts,
  cfg: CompatCfg,
): Promise<ToolUseProviderResult> {
  const model = opts.model ?? cfg.defaultModel;
  // Sanitize tool names + parameter schemas — see module-level docs on
  // `makeToolNameSanitizer` and `sanitizeToolSchemaForStrict`. Mirrors
  // the same logic used by `runStreamComplete` below.
  const { sanitize: sanitizeToolName, restore: restoreToolName } =
    makeToolNameSanitizer();
  const openaiTools = opts.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: sanitizeToolName(t.name),
      description: t.description,
      parameters: sanitizeToolSchemaForStrict(
        (t.input_schema ?? { type: "object" }) as Record<string, unknown>,
      ),
    },
  }));

  const openaiMessages = translateMessagesForOpenAI(
    opts.systemPrompt,
    opts.messages,
  );
  const isOpenAI = cfg.provider === "openai";

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(isOpenAI
        ? { max_completion_tokens: opts.maxTokens ?? 4096 }
        : { max_tokens: opts.maxTokens ?? 4096 }),
      tools: openaiTools,
      messages: openaiMessages,
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 60_000),
  });

  if (!res.ok) {
    throw new Error(
      `API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const data = await safeJson(res);
  const choice = (
    data.choices as {
      message: {
        content?: string;
        tool_calls?: {
          id: string;
          function: { name: string; arguments: string };
        }[];
      };
      finish_reason: string;
    }[]
  )?.[0];

  if (!choice) throw new Error("No response from API");

  const rawUsage = data.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined;
  const usage = {
    inputTokens: rawUsage?.prompt_tokens ?? 0,
    outputTokens: rawUsage?.completion_tokens ?? 0,
    cachedInputTokens: rawUsage?.prompt_tokens_details?.cached_tokens ?? 0,
  };

  const toolCalls = choice.message.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
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
        name: restoreToolName(tc.function.name),
        input: parsedInput,
      });
    }
    return { stopReason: "tool_use", content, usage, model };
  }

  return {
    stopReason: "end_turn",
    text: choice.message.content ?? "",
    usage,
    model,
  };
}

export async function runVision(
  opts: VisionOpts,
  cfg: CompatCfg,
): Promise<VisionProviderResult> {
  const model = opts.model ?? cfg.defaultModel;
  const isOpenAI = cfg.provider === "openai";
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(isOpenAI
        ? { max_completion_tokens: opts.maxTokens ?? 512 }
        : { max_tokens: opts.maxTokens ?? 512 }),
      messages: [
        { role: "system", content: opts.systemPrompt },
        {
          role: "user",
          content: [
            ...(opts.message.beforeImageBase64
              ? [
                  { type: "text", text: "BEFORE (broken state):" },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${opts.message.beforeImageBase64}`,
                    },
                  },
                  { type: "text", text: "AFTER (after fix applied):" },
                ]
              : []),
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${opts.message.imageBase64}`,
              },
            },
            { type: "text", text: opts.message.text },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30_000),
  });

  if (!res.ok) {
    throw new Error(
      `Vision API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = await safeJson(res);
  const text =
    ((data.choices as { message: { content: string } }[])?.[0]?.message
      ?.content as string) ?? "";
  const rawUsage = data.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined;
  return {
    text,
    usage: {
      inputTokens: rawUsage?.prompt_tokens ?? 0,
      outputTokens: rawUsage?.completion_tokens ?? 0,
      cachedInputTokens: rawUsage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model,
  };
}

/**
 * Translate the unified Claude-shaped AIMessage format to OpenAI's flat
 * tool_call_id form. Mirrors the existing client.ts implementation.
 */
function translateMessagesForOpenAI(
  systemPrompt: string,
  messages: AIMessage[],
): {
  role: string;
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}[] {
  const result: {
    role: string;
    content?: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
  }[] = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content as ContentBlock[];
    const toolUses = blocks.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    const toolResults = blocks.filter(
      (b): b is ToolResultBlock => b.type === "tool_result",
    );
    const textBlocks = blocks.filter((b): b is TextBlock => b.type === "text");

    if (toolUses.length > 0) {
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
      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }
    } else if (textBlocks.length > 0) {
      result.push({
        role: msg.role,
        content: textBlocks.map((b) => b.text).join("\n"),
      });
    }
  }

  return result;
}

// ── Streaming (OpenAI-compat /v1/chat/completions SSE) ─────────────────────

export async function* runStreamComplete(
  opts: StreamCompleteOpts,
  cfg: CompatCfg,
): StreamCompleteResult {
  const model = opts.model ?? cfg.defaultModel;
  const isOpenAI = cfg.provider === "openai";
  // OpenAI tool-call body shape: same as runWithTools above. When the
  // caller didn't pass tools we leave the field off entirely — passing
  // `tools: []` makes some providers (Groq) return 400.
  const tools = opts.tools;

  // Sanitize tool names + parameter schemas — see module-level docs on
  // `makeToolNameSanitizer` and `sanitizeToolSchemaForStrict`. Mirrors
  // the logic in `runWithTools` above.
  const { sanitize: sanitizeToolName, restore: restoreToolName } =
    makeToolNameSanitizer();

  const openaiTools =
    tools && tools.length > 0
      ? tools.map((t) => ({
          type: "function" as const,
          function: {
            name: sanitizeToolName(t.name),
            description: t.description,
            parameters: sanitizeToolSchemaForStrict(
              (t.input_schema ?? { type: "object" }) as Record<string, unknown>,
            ),
          },
        }))
      : undefined;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(isOpenAI
        ? { max_completion_tokens: opts.maxTokens ?? 1024 }
        : { max_tokens: opts.maxTokens ?? 1024 }),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(openaiTools ? { tools: openaiTools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: opts.systemPrompt }, ...opts.messages],
    }),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeout ?? 60_000),
  });

  if (!res.ok) {
    throw new Error(
      `API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: AIUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let finishReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { type: "final", final: { usage, model, finishReason } };
          return;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            };
          };
          const choice = parsed.choices?.[0];
          const text = choice?.delta?.content;
          if (text) yield { type: "delta", delta: text };
          // Tool-call deltas. OpenAI streams ONE entry per active call
          // per chunk; we surface one toolCall event per entry preserving
          // `index` so the consumer's accumulator can interleave multiple
          // parallel calls cleanly.
          const toolCalls = choice?.delta?.tool_calls;
          if (toolCalls && toolCalls.length > 0) {
            for (const tc of toolCalls) {
              // Reverse the outbound name sanitization so the Rust
              // ToolRegistry receives the exact registered name
              // (e.g. `cloud-list_projects` → `cloud.list_projects`).
              // Only the first delta of a given tool-call carries the
              // function.name field; subsequent deltas carry only
              // arguments fragments, so the lookup is a no-op there.
              const rawName = tc.function?.name;
              const mappedName = rawName ? restoreToolName(rawName) : undefined;
              yield {
                type: "toolCall",
                toolCall: {
                  index: tc.index ?? 0,
                  id: tc.id,
                  name: mappedName,
                  argsDelta: tc.function?.arguments ?? "",
                },
              };
            }
          }
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          if (parsed.usage) {
            usage = {
              inputTokens: parsed.usage.prompt_tokens ?? usage.inputTokens,
              outputTokens: parsed.usage.completion_tokens ?? usage.outputTokens,
              cachedInputTokens:
                parsed.usage.prompt_tokens_details?.cached_tokens ??
                usage.cachedInputTokens,
            };
          }
        } catch {
          // skip non-JSON keep-alive frames
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  yield { type: "final", final: { usage, model, finishReason } };
}

// ── Validate key (OpenAI-compat /v1/models GET) ────────────────────────────

export async function runValidateKey(
  apiKey: string,
  cfg: CompatCfg,
  invalidErrorMsg: string,
): Promise<ValidateKeyResult> {
  if (!apiKey || apiKey.trim() === "") {
    return { valid: false, error: "API key is required" };
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: invalidErrorMsg };
    }
    if (!res.ok) {
      return {
        valid: false,
        error: `Provider returned ${res.status} on /models — try again`,
      };
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (data?.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    return { valid: true, modelsAvailable: ids };
  } catch (err) {
    return {
      valid: false,
      error: `Could not validate key — ${err instanceof Error ? err.message : "network error"}`,
    };
  }
}

/**
 * Flatten content-block messages to text for providers without tool support
 * (Gemini). Exposed for google.ts.
 */
export function flattenMessages(messages: AIMessage[]): AIMessage[] {
  return messages.map((m) => ({
    ...m,
    content:
      typeof m.content === "string"
        ? m.content
        : (m.content as ContentBlock[])
            .filter((b) => b.type === "text")
            .map((b) => (b as TextBlock).text)
            .join("\n"),
  }));
}

/**
 * Public re-exports of helper builders that web's prompt-caching
 * paths depend on (Anthropic). Kept here so the providers/ surface stays
 * cohesive. Anthropic-specific helpers live in anthropic.ts.
 */
export type { ToolDefinition, ToolUseProviderResult };
