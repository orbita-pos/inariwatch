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
  type ToolDefinition,
  type ToolResultBlock,
  type ToolUseBlock,
  type TextBlock,
  type ToolUseOpts,
  type AIResponse,
  type ToolUseProviderResult,
  type VisionOpts,
  type VisionProviderResult,
  safeJson,
} from "./types";

interface CompatCfg {
  baseUrl: string;
  provider: AIProvider;
  defaultModel: string;
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
  const openaiTools = opts.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
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
        name: tc.function.name,
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
