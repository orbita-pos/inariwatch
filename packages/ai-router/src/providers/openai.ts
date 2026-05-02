// OpenAI provider adapter.
//
// THIS IS THE ONLY FILE IN THE REPO ALLOWED TO TALK TO api.openai.com.
//
// Two endpoints live here:
//   - Chat Completions (gpt-4o, gpt-4o-mini, gpt-3.5, etc.)
//   - Responses API (gpt-5.x family — required, Chat Completions silently
//     drops reasoning context across tool turns)
//
// The Responses API path is automatically selected for any model whose name
// matches the GPT-5.x prefix list — see isGPT5Family below. Callers don't
// pick the path explicitly.

import {
  type AIMessage,
  type AIResponse,
  type CompleteOpts,
  type ContentBlock,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ToolUseOpts,
  type ToolUseProviderResult,
  type VisionOpts,
  type VisionProviderResult,
} from "./types";
import {
  runComplete as compatComplete,
  runWithTools as compatWithTools,
  runVision as compatVision,
} from "./_openai-compat-shared";
import { safeJson } from "./types";

const BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_TOOL_MODEL = "gpt-4o";
const DEFAULT_RESPONSES_MODEL = "gpt-5.4-mini";

const COMPAT_CFG = {
  baseUrl: BASE_URL,
  provider: "openai" as const,
  defaultModel: DEFAULT_CHAT_MODEL,
};

export async function complete(opts: CompleteOpts): Promise<AIResponse> {
  return compatComplete(opts, COMPAT_CFG);
}

export async function withTools(
  opts: ToolUseOpts,
): Promise<ToolUseProviderResult> {
  const model = opts.model ?? DEFAULT_TOOL_MODEL;
  // GPT-5.x reasoning models MUST use the Responses API — Chat Completions
  // silently drops reasoning context between tool calls (~30% degradation
  // measured by Cursor) and loses prompt cache wins.
  if (isGPT5Family(model)) {
    return responsesWithTools({ ...opts, model });
  }
  return compatWithTools(opts, { ...COMPAT_CFG, defaultModel: DEFAULT_TOOL_MODEL });
}

export async function vision(opts: VisionOpts): Promise<VisionProviderResult> {
  return compatVision(opts, { ...COMPAT_CFG, defaultModel: DEFAULT_CHAT_MODEL });
}

// ── GPT-5.x model detection (provider-side) ─────────────────────────────────

const GPT_5_MODEL_PREFIXES = [
  "gpt-5",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
] as const;

export function isGPT5Family(model: string): boolean {
  const lower = model.toLowerCase();
  return GPT_5_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

interface OpenAIProviderOptions {
  store: boolean;
  include: string[];
  textVerbosity?: "low" | "medium" | "high";
}

function getOpenAIProviderOptions(modelId: string): OpenAIProviderOptions {
  const base: OpenAIProviderOptions = {
    // Never persist server-side; InariLens is the SSOT.
    store: false,
    // Required companion to store:false for multi-turn reasoning models —
    // without this the second turn errors with "Item rs_... not found".
    include: ["reasoning.encrypted_content"],
  };

  // gpt-5.4 clamps to low verbosity — the regression-prone version of the
  // GPT-5 family added preamble/recap that wastes output tokens.
  if (modelId.toLowerCase().startsWith("gpt-5.4")) {
    base.textVerbosity = "low";
  }
  return base;
}

// ── Responses API path (gpt-5.x) ────────────────────────────────────────────

async function responsesWithTools(
  opts: ToolUseOpts,
): Promise<ToolUseProviderResult> {
  const model = opts.model ?? DEFAULT_RESPONSES_MODEL;
  const providerOpts = getOpenAIProviderOptions(model);

  const responsesTools = opts.tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
    strict: opts.strict ?? false,
  }));

  const input = buildResponsesInput(opts.messages, opts.priorOutput);

  const body: Record<string, unknown> = {
    model,
    input,
    tools: responsesTools,
    tool_choice: opts.toolChoice ?? "auto",
    parallel_tool_calls: opts.parallelToolCalls ?? (opts.strict ? false : true),
    max_output_tokens: opts.maxTokens ?? 4096,
    store: providerOpts.store,
    include: providerOpts.include,
    instructions: opts.systemPrompt,
  };

  if (providerOpts.textVerbosity) {
    body.text = { verbosity: providerOpts.textVerbosity };
  }

  if (opts.reasoningEffort) {
    body.reasoning = { effort: opts.reasoningEffort, summary: "auto" };
  }

  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // Reasoning models can run longer.
    signal: AbortSignal.timeout(opts.timeout ?? 120_000),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    throw new Error(`OpenAI Responses API error (${res.status}): ${errText}`);
  }

  const data = await safeJson(res);
  const responseId = data.id as string;

  const rawUsage = data.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined;
  const usage = {
    inputTokens: rawUsage?.input_tokens ?? 0,
    outputTokens: rawUsage?.output_tokens ?? 0,
    cachedInputTokens: rawUsage?.input_tokens_details?.cached_tokens ?? 0,
  };

  const output = (data.output as Array<Record<string, unknown>>) ?? [];
  const priorOutput = output;

  const functionCalls = output.filter(
    (o) => o.type === "function_call",
  ) as Array<{
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
        id: fc.call_id,
        name: fc.name,
        input: parsedInput,
      };
    });
    return {
      stopReason: "tool_use",
      content,
      usage,
      model,
      responseId,
      priorOutput,
    };
  }

  const messageItem = output.find((o) => o.type === "message") as
    | { content?: Array<{ type: string; text?: string }> }
    | undefined;
  const text =
    messageItem?.content?.find((p) => p.type === "output_text")?.text ?? "";

  return {
    stopReason: "end_turn",
    text,
    usage,
    model,
    responseId,
    priorOutput,
  };
}

/**
 * Build the Responses API input array.
 *
 * Strategy (store:false / stateless mode):
 *   1. Walk messages chronologically.
 *   2. Replace the LAST assistant message with the verbatim priorOutput
 *      items so reasoning.encrypted_content + function_call stay paired.
 *   3. After priorOutput, expand tool_result blocks into
 *      function_call_output items keyed by call_id.
 *   4. Earlier messages with tool_use blocks expand into function_call
 *      items so downstream function_call_output items still resolve.
 *
 * Without this exact shape the API 400s with "No tool call found for
 * function call output with call_id ..." after the second turn.
 */
export function buildResponsesInput(
  messages: AIMessage[],
  priorOutput?: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

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

    if (isLastAssistant && priorOutput && priorOutput.length > 0) {
      items.push(...priorOutput);
      continue;
    }

    if (m.role === "assistant" && Array.isArray(m.content)) {
      const blocks = m.content as ContentBlock[];
      const hasToolUse = blocks.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        const textParts = blocks
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (textParts.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: textParts,
          });
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

    if (m.role === "user" && Array.isArray(m.content)) {
      const blocks = m.content as ContentBlock[];
      const toolResults = blocks.filter(
        (b) => b.type === "tool_result",
      ) as ToolResultBlock[];
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          items.push({
            type: "function_call_output",
            call_id: tr.tool_use_id,
            output:
              typeof tr.content === "string"
                ? tr.content
                : JSON.stringify(tr.content),
          });
        }
        continue;
      }
    }

    items.push(toResponsesItem(m));
  }

  return items;
}

function toResponsesItem(m: AIMessage): Record<string, unknown> {
  if (typeof m.content === "string") {
    return { type: "message", role: m.role, content: m.content };
  }
  const flat = (m.content as ContentBlock[])
    .map((b) => {
      if (b.type === "text") return (b as TextBlock).text;
      if (b.type === "tool_use") return `[tool_use ${(b as ToolUseBlock).name}]`;
      if (b.type === "tool_result")
        return typeof b.content === "string"
          ? b.content
          : JSON.stringify(b.content);
      return "";
    })
    .join("\n");
  return { type: "message", role: m.role, content: flat };
}

// ── Embeddings ──────────────────────────────────────────────────────────────

export async function embed(
  apiKey: string,
  input: string | string[],
  model = "text-embedding-3-small",
  timeout = 30_000,
  dimensions?: number,
): Promise<{ vectors: number[][]; model: string; usage: { inputTokens: number } }> {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      ...(dimensions !== undefined ? { dimensions } : {}),
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    throw new Error(
      `OpenAI Embeddings API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = await safeJson(res);
  const vectors = ((data.data as { embedding: number[] }[]) ?? []).map(
    (r) => r.embedding,
  );
  const usage = data.usage as { prompt_tokens?: number } | undefined;
  return {
    vectors,
    model,
    usage: { inputTokens: usage?.prompt_tokens ?? 0 },
  };
}
