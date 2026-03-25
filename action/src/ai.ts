type Provider = "claude" | "openai" | "grok" | "deepseek" | "gemini";

export function detectProvider(key: string): Provider {
  if (key.startsWith("sk-ant-")) return "claude";
  if (key.startsWith("xai-")) return "grok";
  if (key.startsWith("AIza")) return "gemini";
  return "openai";
}

const DEFAULT_MODELS: Record<Provider, string> = {
  claude: "claude-sonnet-4-5-20241022",
  openai: "gpt-4o-mini",
  grok: "grok-beta",
  deepseek: "deepseek-chat",
  gemini: "gemini-2.0-flash",
};

export async function callAI(
  key: string,
  system: string,
  prompt: string,
  opts: { model?: string; maxTokens?: number } = {}
): Promise<string> {
  const provider = detectProvider(key);
  const model = opts.model || DEFAULT_MODELS[provider];
  const maxTokens = opts.maxTokens || 1024;

  if (provider === "claude") {
    return callClaude(key, model, system, prompt, maxTokens);
  }
  if (provider === "gemini") {
    return callGemini(key, model, system, prompt, maxTokens);
  }

  // OpenAI-compatible: openai, grok, deepseek
  const baseUrl =
    provider === "grok"
      ? "https://api.x.ai/v1"
      : provider === "deepseek"
      ? "https://api.deepseek.com/v1"
      : "https://api.openai.com/v1";

  return callOpenAICompat(key, baseUrl, model, system, prompt, maxTokens);
}

async function callClaude(
  key: string, model: string, system: string, prompt: string, maxTokens: number
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

async function callOpenAICompat(
  key: string, baseUrl: string, model: string, system: string, prompt: string, maxTokens: number
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callGemini(
  key: string, model: string, system: string, prompt: string, maxTokens: number
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
