/**
 * AI client for the worker — extracted from web/lib/ai/client.ts.
 * Supports Claude, OpenAI, Grok, DeepSeek, Groq (tool use).
 * Zero dependencies — uses native fetch.
 */

export type AIProvider = "claude" | "openai" | "grok" | "deepseek" | "gemini" | "groq";
export type AIMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

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

// ── Main dispatcher ─────────────────────────────────────────────────────────

export async function callAIWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: { maxTokens?: number; model?: string; timeout?: number; provider?: AIProvider } = {}
): Promise<ToolUseResponse> {
  const provider = opts.provider ?? detectProvider(apiKey);

  switch (provider) {
    case "claude":
      return callClaudeWithTools(apiKey, systemPrompt, messages, tools, opts);
    case "openai":
      return callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.openai.com/v1");
    case "grok":
      return callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.x.ai/v1");
    case "deepseek":
      return callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.deepseek.com/v1");
    case "groq":
      return callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.groq.com/openai/v1");
    case "gemini":
      // Gemini doesn't support tool use in this format — return empty
      return { stopReason: "end_turn", text: "Gemini does not support tool use" };
  }
}

function detectProvider(key: string): AIProvider {
  if (key.startsWith("sk-ant-")) return "claude";
  if (key.startsWith("xai-")) return "grok";
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("AIza")) return "gemini";
  return "openai";
}

// ── Claude ───────────────────────────────────────────────────────────────────

async function callClaudeWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<ToolUseResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-4-6",
      max_tokens: opts.maxTokens ?? 4096,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 90_000),
  });

  if (!res.ok) throw new Error(`Claude API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const stopReason = data.stop_reason as string;
  const content = data.content as ContentBlock[];

  if (stopReason === "tool_use") {
    return { stopReason: "tool_use", content };
  }

  const textBlock = content.find((c) => c.type === "text") as TextBlock | undefined;
  return { stopReason: "end_turn", text: textBlock?.text ?? "" };
}

// ── OpenAI-Compatible (OpenAI, Grok, DeepSeek, Groq) ────────────────────────

function translateMessagesForOpenAI(
  systemPrompt: string,
  messages: AIMessage[]
): { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[] {
  const result: { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content as ContentBlock[];
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
    const textBlocks = blocks.filter((b): b is TextBlock => b.type === "text");

    if (toolUses.length > 0) {
      result.push({
        role: "assistant",
        content: textBlocks.map((b) => b.text).join("\n") || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        })),
      });
    } else if (toolResults.length > 0) {
      for (const tr of toolResults) {
        result.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content });
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
): Promise<ToolUseResponse> {
  const openaiTools = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? "gpt-4o",
      max_tokens: opts.maxTokens ?? 4096,
      tools: openaiTools,
      messages: translateMessagesForOpenAI(systemPrompt, messages),
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 90_000),
  });

  if (!res.ok) throw new Error(`API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const choice = (data.choices as { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[])?.[0];
  if (!choice) throw new Error("No response from API");

  const toolCalls = choice.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const tc of toolCalls) {
      let parsedInput: Record<string, unknown>;
      try { parsedInput = JSON.parse(tc.function.arguments); } catch { parsedInput = { raw: tc.function.arguments }; }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsedInput });
    }
    return { stopReason: "tool_use", content };
  }

  return { stopReason: "end_turn", text: choice.message.content ?? "" };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`API returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
}
