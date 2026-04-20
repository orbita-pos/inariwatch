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
  | { stopReason: "tool_use"; content: ContentBlock[]; responseId?: string }
  | { stopReason: "end_turn"; text: string; responseId?: string };

export interface CallAIWithToolsOpts {
  maxTokens?: number;
  model?: string;
  timeout?: number;
  provider?: AIProvider;
  /** Previous turn's response id — Responses API threading (GPT-5.x only). */
  previousResponseId?: string;
  /** Reasoning budget per turn (reasoning models only). */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Enables strict JSON schema on tool calls. */
  strict?: boolean;
  /** Forces a specific tool on the next turn. */
  toolChoice?: "auto" | "required" | { type: "function"; name: string };
  /** Allow parallel tool calls in one turn. Default true. */
  parallelToolCalls?: boolean;
}

const GPT_5_PREFIXES = ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4"] as const;

function isGPT5Family(model: string): boolean {
  const lower = model.toLowerCase();
  return GPT_5_PREFIXES.some((p) => lower.startsWith(p));
}

// ── Main dispatcher ─────────────────────────────────────────────────────────

export async function callAIWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: CallAIWithToolsOpts = {}
): Promise<ToolUseResponse> {
  const provider = opts.provider ?? detectProvider(apiKey);

  switch (provider) {
    case "claude":
      return callClaudeWithTools(apiKey, systemPrompt, messages, tools, opts);
    case "openai": {
      // GPT-5.x reasoning models MUST use Responses API — Chat Completions
      // drops reasoning context between tool calls (Cursor measured ~30%
      // regression without it).
      const model = opts.model ?? "gpt-4o-mini";
      if (isGPT5Family(model)) {
        return callOpenAIResponsesWithTools(apiKey, systemPrompt, messages, tools, opts);
      }
      return callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.openai.com/v1");
    }
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

// ── OpenAI Responses API (GPT-5.x) ─────────────────────────────────────────

async function callOpenAIResponsesWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: CallAIWithToolsOpts
): Promise<ToolUseResponse> {
  const model = opts.model ?? "gpt-5.4-mini";

  const responsesTools = tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
    strict: opts.strict ?? false,
  }));

  const input = opts.previousResponseId
    ? buildIncrementalResponsesInput(messages)
    : buildFullResponsesInput(messages);

  const body: Record<string, unknown> = {
    model,
    input,
    tools: responsesTools,
    tool_choice: opts.toolChoice ?? "auto",
    parallel_tool_calls: opts.parallelToolCalls ?? (opts.strict ? false : true),
    max_output_tokens: opts.maxTokens ?? 4096,
    store: false,
    include: ["reasoning.encrypted_content"],
  };

  // gpt-5.4 verbosity clamp.
  if (model.toLowerCase().startsWith("gpt-5.4")) {
    body.text = { verbosity: "low" };
  }

  if (!opts.previousResponseId) {
    body.instructions = systemPrompt;
  } else {
    body.previous_response_id = opts.previousResponseId;
  }

  if (opts.reasoningEffort) {
    body.reasoning = { effort: opts.reasoningEffort, summary: "auto" };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeout ?? 120_000),
  });

  if (!res.ok) {
    throw new Error(`OpenAI Responses API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = await safeJson(res);
  const responseId = data.id as string;

  const output = (data.output as Array<Record<string, unknown>>) ?? [];
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
      return { type: "tool_use" as const, id: fc.call_id, name: fc.name, input: parsedInput };
    });
    return { stopReason: "tool_use", content, responseId };
  }

  const messageItem = output.find((o) => o.type === "message") as
    | { content?: Array<{ type: string; text?: string }> }
    | undefined;
  const text = messageItem?.content?.find((p) => p.type === "output_text")?.text ?? "";
  return { stopReason: "end_turn", text, responseId };
}

function buildFullResponsesInput(messages: AIMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => toResponsesItem(m));
}

function buildIncrementalResponsesInput(messages: AIMessage[]): Array<Record<string, unknown>> {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const newMessages = messages.slice(lastAssistantIdx + 1);
  return newMessages.flatMap((m) => {
    if (m.role === "user" && Array.isArray(m.content)) {
      const blocks = m.content as ContentBlock[];
      const toolResults = blocks.filter((b) => b.type === "tool_result") as ToolResultBlock[];
      if (toolResults.length > 0) {
        return toolResults.map((tr) => ({
          type: "function_call_output",
          call_id: tr.tool_use_id,
          output: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
        }));
      }
    }
    return [toResponsesItem(m)];
  });
}

function toResponsesItem(m: AIMessage): Record<string, unknown> {
  if (typeof m.content === "string") {
    return { type: "message", role: m.role, content: m.content };
  }
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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`API returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
}
