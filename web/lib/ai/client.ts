/**
 * Unified AI client — Claude, OpenAI, Grok, DeepSeek, Gemini, Groq.
 * Grok, DeepSeek, and Groq are OpenAI-compatible (different base URL).
 * Gemini uses its own REST API.
 */

export type AIMessage = { role: "user" | "assistant"; content: string };
export type AIVisionMessage = { role: "user"; text: string; imageBase64: string; beforeImageBase64?: string };

export type AIProvider = "claude" | "openai" | "grok" | "deepseek" | "gemini" | "groq";

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

/**
 * Call the AI with a system prompt + messages and return the text response.
 * Pass opts.provider to override auto-detection (required for DeepSeek).
 */
export async function callAI(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number; provider?: AIProvider } = {}
): Promise<string> {
  const provider = opts.provider ?? detectProvider(apiKey);

  switch (provider) {
    case "claude":
      return callClaude(apiKey, systemPrompt, messages, opts);
    case "grok":
      return callOpenAICompat(apiKey, systemPrompt, messages, opts, "https://api.x.ai/v1");
    case "groq":
      return callOpenAICompat(apiKey, systemPrompt, messages, opts, "https://api.groq.com/openai/v1");
    case "deepseek":
      return callOpenAICompat(apiKey, systemPrompt, messages, opts, "https://api.deepseek.com/v1");
    case "gemini":
      return callGemini(apiKey, systemPrompt, messages, opts);
    default:
      return callOpenAICompat(apiKey, systemPrompt, messages, opts, "https://api.openai.com/v1");
  }
}

/**
 * Call the AI with a screenshot (base64 PNG) and a text prompt.
 * Uses the user's BYOK provider. All major providers support vision.
 * Groq and DeepSeek don't support vision — falls back to text-only with a note.
 */
export async function callAIVision(
  apiKey: string,
  systemPrompt: string,
  message: AIVisionMessage,
  opts: { maxTokens?: number; model?: string; timeout?: number; provider?: AIProvider } = {}
): Promise<string> {
  const provider = opts.provider ?? detectProvider(apiKey);

  switch (provider) {
    case "claude":
      return callClaudeVision(apiKey, systemPrompt, message, opts);
    case "gemini":
      return callGeminiVision(apiKey, systemPrompt, message, opts);
    case "groq":
    case "deepseek":
      // No vision support — fall back to text-only
      return callAI(apiKey, systemPrompt, [{ role: "user", content: `${message.text}\n\n(Screenshot was captured but your AI provider does not support vision. Analysis is text-only.)` }], opts);
    default:
      // OpenAI, Grok — both support OpenAI-compatible vision
      return callOpenAICompatVision(apiKey, systemPrompt, message, opts,
        provider === "grok" ? "https://api.x.ai/v1" : "https://api.openai.com/v1");
  }
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

  if (!res.ok) throw new Error(`Claude API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  return (data.content as { text: string }[])?.[0]?.text ?? "";
}

/** Shared implementation for OpenAI, Grok (xAI), and DeepSeek (all OpenAI-compatible). */
async function callOpenAICompat(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number },
  baseUrl: string
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
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

  if (!res.ok) throw new Error(`API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  return ((data.choices as { message: { content: string } }[])?.[0]?.message?.content as string) ?? "";
}

async function callGemini(
  apiKey: string,
  system: string,
  messages: AIMessage[],
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<string> {
  const model = opts.model ?? "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 1024 },
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });

  if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  return ((data.candidates as { content: { parts: { text: string }[] } }[])?.[0]?.content?.parts?.[0]?.text as string) ?? "";
}

// ── Vision implementations ──────────────────────────────────────────────────

async function callClaudeVision(
  apiKey: string,
  system: string,
  msg: AIVisionMessage,
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
  return (data.content as { text: string }[])?.[0]?.text ?? "";
}

async function callOpenAICompatVision(
  apiKey: string,
  system: string,
  msg: AIVisionMessage,
  opts: { maxTokens?: number; model?: string; timeout?: number },
  baseUrl: string
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? "gpt-4o-mini",
      max_tokens: opts.maxTokens ?? 512,
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
  return ((data.choices as { message: { content: string } }[])?.[0]?.message?.content as string) ?? "";
}

async function callGeminiVision(
  apiKey: string,
  system: string,
  msg: AIVisionMessage,
  opts: { maxTokens?: number; model?: string; timeout?: number }
): Promise<string> {
  const model = opts.model ?? "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  return ((data.candidates as { content: { parts: { text: string }[] } }[])?.[0]?.content?.parts?.[0]?.text as string) ?? "";
}
