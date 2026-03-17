/**
 * Unified AI client — supports Claude (sk-ant-*) and OpenAI (sk-*).
 * Uses fetch directly to keep dependencies minimal for OpenAI;
 * uses @anthropic-ai/sdk for Claude (better streaming support in the future).
 */

export type AIMessage = { role: "user" | "assistant"; content: string };

export type AIProvider = "claude" | "openai";

/**
 * Detect the AI provider from the key prefix.
 */
export function detectProvider(key: string): AIProvider {
  return key.startsWith("sk-ant-") ? "claude" : "openai";
}

/**
 * Call the AI with a system prompt + messages and return the text response.
 */
export async function callAI(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number } = {}
): Promise<string> {
  const provider = detectProvider(apiKey);

  if (provider === "claude") {
    return callClaude(apiKey, systemPrompt, messages, opts);
  } else {
    return callOpenAI(apiKey, systemPrompt, messages, opts);
  }
}

async function callClaude(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-4-6",
      max_tokens: opts.maxTokens ?? 1024,
      system,
      messages,
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) {
    throw new Error(`Claude API error (${res.status}): ${res.statusText}`);
  }

  const data = await res.json();
  return (data.content?.[0]?.text as string) ?? "";
}

async function callOpenAI(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? "gpt-4o-mini",
      max_tokens: opts.maxTokens ?? 1024,
      messages: [{ role: "system", content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error (${res.status}): ${res.statusText}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content as string) ?? "";
}
