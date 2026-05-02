// Google Gemini provider adapter.
// THE ONLY FILE allowed to talk to generativelanguage.googleapis.com.

import {
  type AIMessage,
  type AIResponse,
  type AIUsage,
  type CompleteOpts,
  type StreamCompleteOpts,
  type StreamCompleteResult,
  type ToolUseOpts,
  type ToolUseProviderResult,
  type ValidateKeyResult,
  type VisionOpts,
  type VisionProviderResult,
  safeJson,
} from "./types";
import { flattenMessages } from "./_openai-compat-shared";

const DEFAULT_MODEL = "gemini-1.5-flash";

function endpointFor(model: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error("Invalid Gemini model name");
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function streamEndpointFor(model: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error("Invalid Gemini model name");
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
}

export async function complete(opts: CompleteOpts): Promise<AIResponse> {
  const model = opts.model ?? DEFAULT_MODEL;
  const url = endpointFor(model);

  const contents = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : "" }],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 1024 },
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30_000),
  });

  if (!res.ok) {
    throw new Error(
      `Gemini API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const data = await safeJson(res);
  const text =
    ((data.candidates as { content: { parts: { text: string }[] } }[])?.[0]
      ?.content?.parts?.[0]?.text as string) ?? "";
  const usage = data.usageMetadata as
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      }
    | undefined;

  return {
    text,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
    },
    model,
    provider: "gemini",
  };
}

/**
 * Gemini's function-calling format is incompatible with our unified ToolUse
 * shape. The dispatch layer falls back to text-only by calling complete()
 * with flattened messages — replicating the existing client.ts behavior.
 */
export async function withTools(
  opts: ToolUseOpts,
): Promise<ToolUseProviderResult> {
  const flat: AIMessage[] = flattenMessages(opts.messages);
  const r = await complete({ ...opts, messages: flat });
  return {
    stopReason: "end_turn",
    text: r.text,
    usage: r.usage,
    model: r.model,
  };
}

export async function vision(opts: VisionOpts): Promise<VisionProviderResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const url = endpointFor(model);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            ...(opts.message.beforeImageBase64
              ? [
                  { text: "BEFORE (broken state):" },
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: opts.message.beforeImageBase64,
                    },
                  },
                  { text: "AFTER (after fix applied):" },
                ]
              : []),
            {
              inlineData: {
                mimeType: "image/png",
                data: opts.message.imageBase64,
              },
            },
            { text: opts.message.text },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 512 },
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 30_000),
  });

  if (!res.ok) {
    throw new Error(
      `Gemini Vision API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = await safeJson(res);
  const text =
    ((data.candidates as { content: { parts: { text: string }[] } }[])?.[0]
      ?.content?.parts?.[0]?.text as string) ?? "";
  const usage = data.usageMetadata as
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      }
    | undefined;
  return {
    text,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
    },
    model,
  };
}

export async function* streamComplete(
  opts: StreamCompleteOpts,
): StreamCompleteResult {
  const model = opts.model ?? DEFAULT_MODEL;
  const url = streamEndpointFor(model);
  const contents = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : "" }],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": opts.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 1024 },
    }),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeout ?? 60_000),
  });

  if (!res.ok) {
    throw new Error(
      `Gemini API error (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: AIUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

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
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
            }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              cachedContentTokenCount?: number;
            };
          };
          const text =
            parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          if (text) yield { type: "delta", delta: text };
          if (parsed.usageMetadata) {
            usage = {
              inputTokens:
                parsed.usageMetadata.promptTokenCount ?? usage.inputTokens,
              outputTokens:
                parsed.usageMetadata.candidatesTokenCount ?? usage.outputTokens,
              cachedInputTokens:
                parsed.usageMetadata.cachedContentTokenCount ??
                usage.cachedInputTokens,
            };
          }
        } catch {
          /* skip non-JSON */
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
  yield { type: "final", final: { usage, model } };
}

export async function validateKey(apiKey: string): Promise<ValidateKeyResult> {
  if (!apiKey || apiKey.trim() === "") {
    return { valid: false, error: "API key is required" };
  }
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { valid: false, error: "Invalid Gemini API key — replace it in Settings → AI" };
    }
    if (!res.ok) {
      return {
        valid: false,
        error: `Google returned ${res.status} on /models — try again`,
      };
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return {
      valid: true,
      modelsAvailable: (data?.models ?? [])
        .map((m) => m.name ?? "")
        .filter(Boolean),
    };
  } catch (err) {
    return {
      valid: false,
      error: `Could not validate key — ${err instanceof Error ? err.message : "network error"}`,
    };
  }
}
