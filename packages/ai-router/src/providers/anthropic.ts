// Anthropic (Claude) provider adapter.
//
// THIS IS THE ONLY FILE IN THE REPO ALLOWED TO TALK TO api.anthropic.com.
// Lockdown rule: web/lib/, web/app/, desktop/, cli/, capture/ MUST NOT issue
// raw fetch to anthropic.com or import @anthropic-ai/sdk. Use dispatch().

import {
  type AIMessage,
  type ContentBlock,
  type CompleteOpts,
  type ToolDefinition,
  type ToolUseOpts,
  type AIResponse,
  type ToolUseProviderResult,
  type VisionOpts,
  type VisionProviderResult,
  type TextBlock,
  type AIUsage,
  safeJson,
} from "./types";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_PROMPT_CACHING = "prompt-caching-2024-07-31";
const DEFAULT_MODEL = "claude-sonnet-4-6";

export async function complete(opts: CompleteOpts): Promise<AIResponse> {
  const model = opts.model ?? DEFAULT_MODEL;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_PROMPT_CACHING,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system: [
        { type: "text", text: opts.systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      messages: opts.messages,
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30_000),
  });

  if (!res.ok) {
    throw new Error(
      `Claude API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

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
      inputTokens:
        (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    },
    model,
    provider: "claude",
  };
}

export async function withTools(
  opts: ToolUseOpts,
): Promise<ToolUseProviderResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_PROMPT_CACHING,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      // 3 cache breakpoints per the existing implementation:
      //   1) system prompt
      //   2) last tool definition (covers tools array)
      //   3) last message's last block (rolling prefix)
      system: [
        { type: "text", text: opts.systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      tools: buildToolsWithCache(opts.tools),
      messages: buildMessagesWithCache(opts.messages),
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 60_000),
  });

  if (!res.ok) {
    throw new Error(
      `Claude API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const data = await safeJson(res);
  const stopReason = data.stop_reason as string;
  const content = data.content as ContentBlock[];
  const rawUsage = data.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  const usage: AIUsage = {
    inputTokens:
      (rawUsage?.input_tokens ?? 0) + (rawUsage?.cache_read_input_tokens ?? 0),
    outputTokens: rawUsage?.output_tokens ?? 0,
    cachedInputTokens: rawUsage?.cache_read_input_tokens ?? 0,
  };

  if (stopReason === "tool_use") {
    return { stopReason: "tool_use", content, usage, model };
  }

  const textBlock = content.find((c) => c.type === "text") as
    | TextBlock
    | undefined;
  return {
    stopReason: "end_turn",
    text: textBlock?.text ?? "",
    usage,
    model,
  };
}

export async function vision(opts: VisionOpts): Promise<VisionProviderResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 512,
      system: opts.systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            ...(opts.message.beforeImageBase64
              ? [
                  { type: "text", text: "BEFORE (broken state):" },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: opts.message.beforeImageBase64,
                    },
                  },
                  { type: "text", text: "AFTER (after fix applied):" },
                ]
              : []),
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: opts.message.imageBase64,
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
      `Claude Vision API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = await safeJson(res);
  const text = (data.content as { text: string }[])?.[0]?.text ?? "";
  const usage = data.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  return {
    text,
    usage: {
      inputTokens:
        (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    },
    model,
  };
}

// ── Cache helpers (Anthropic-specific) ──────────────────────────────────────

/**
 * Attach cache_control to the last tool. Claude treats this as "cache up to
 * and including" so a single breakpoint covers the entire tools array.
 */
export function buildToolsWithCache(
  tools: ToolDefinition[],
): Record<string, unknown>[] {
  const mapped: Record<string, unknown>[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  if (mapped.length === 0) return mapped;
  mapped[mapped.length - 1] = {
    ...mapped[mapped.length - 1],
    cache_control: { type: "ephemeral" },
  };
  return mapped;
}

/**
 * Attach cache_control to the last content block of the last message — the
 * rolling-prefix pattern documented by Anthropic for multi-turn tool use.
 * String content gets promoted to a block so the breakpoint has a home.
 */
export function buildMessagesWithCache(
  messages: AIMessage[],
): Array<{ role: string; content: unknown }> {
  if (messages.length === 0) return [];

  const out: Array<{ role: string; content: unknown }> = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const last = out[out.length - 1];

  const contentBlocks: Array<Record<string, unknown>> =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : Array.isArray(last.content)
        ? (last.content as Record<string, unknown>[]).map((b) => ({ ...b }))
        : [];

  if (contentBlocks.length === 0) return out;

  const tail = contentBlocks[contentBlocks.length - 1];
  contentBlocks[contentBlocks.length - 1] = {
    ...tail,
    cache_control: { type: "ephemeral" },
  };
  last.content = contentBlocks;

  return out;
}
