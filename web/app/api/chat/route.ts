import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUserProjectIds } from "@/lib/db";
import { getUserAIKey } from "@/lib/ai/get-key";
import { resolveModel } from "@/lib/ai/models";
import type { AIProvider } from "@/lib/ai/client";
import { gatherChatContext, buildContextString, SYSTEM_OPS } from "@/lib/services/chat.service";
import { assertWithinQuota, incrementQuota, QuotaExceededError } from "@/lib/ai/quota";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const body = await req.json();
  const messages: { role: string; content: string }[] = body.messages ?? [];
  const userMessage = messages[messages.length - 1]?.content;
  if (!userMessage) return new Response("No message", { status: 400 });

  const aiKey = await getUserAIKey(userId);
  if (!aiKey) {
    return Response.json({
      role: "assistant",
      content: "AI is temporarily unavailable. Please try again later.",
    });
  }

  // Platform budget reserve for non-BYOK users
  if (aiKey.isPlatformKey) {
    try {
      const { reservePlatformBudget } = await import("@/lib/ai/spend-guard");
      await reservePlatformBudget(2);
    } catch (err) {
      const { PlatformBudgetExceededError } = await import("@/lib/ai/spend-guard");
      if (err instanceof PlatformBudgetExceededError) {
        return Response.json({
          role: "assistant",
          content: "AI budget limit reached for today. Add your own AI key in Settings for unlimited access.",
        });
      }
      throw err;
    }
  }

  // Enforce per-user chat quota
  try {
    await assertWithinQuota(userId, "chat");
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return Response.json({
        role: "assistant",
        content: `You've used your monthly Ask Inari quota (${err.used}/${err.limit}). Quota resets on the 1st of next month.`,
      });
    }
    throw err;
  }

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) {
    return Response.json({
      role: "assistant",
      content: "You don't have any projects yet. Create one in **Projects** and connect an integration to start monitoring.",
    });
  }

  const ctx = await gatherChatContext(projectIds);
  const context = buildContextString(ctx);

  // Limit conversation history to prevent unbounded token accumulation
  const history = messages.slice(0, -1).slice(-15);
  const aiMessages = [
    ...history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    {
      role: "user" as const,
      content: `${context}\n\n---\n\nUser question: ${userMessage}`,
    },
  ];

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let streamOk = false;
      try {
        const chatModel = resolveModel("chat", aiKey.provider, aiKey.modelPrefs);
        const response = await streamAI(aiKey.key, aiKey.provider, SYSTEM_OPS, aiMessages, chatModel);

        for await (const chunk of response) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        streamOk = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      }
      controller.close();

      // Increment quota only after successful stream — failed AI calls
      // don't count against the user's monthly limit.
      if (streamOk) {
        incrementQuota(userId, "chat").catch(() => {});
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Streaming AI calls ──────────────────────────────────────────────────────
//
// NOTE — v0.3 S1 lockdown exception: streaming dispatch isn't part of the
// `@inariwatch/ai-router` public surface yet. The functions below talk to
// provider URLs directly so the chat stream survives Phase 1 unchanged.
// Tracked as a v0.3 S2 follow-up: add `mode: "stream"` to dispatch() and
// migrate this file. Until then, keep the eslint-disable below in place.

/* eslint-disable inariwatch/no-direct-ai-sdk-import */

async function* streamAI(
  apiKey: string,
  provider: AIProvider,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  model: string,
): AsyncGenerator<string> {
  switch (provider) {
    case "claude":
      yield* streamClaude(apiKey, system, messages, model);
      break;
    case "grok":
      yield* streamOpenAICompat(apiKey, system, messages, model, "https://api.x.ai/v1");
      break;
    case "deepseek":
      yield* streamOpenAICompat(apiKey, system, messages, model, "https://api.deepseek.com/v1");
      break;
    case "gemini":
      yield* streamGemini(apiKey, system, messages, model);
      break;
    default:
      yield* streamOpenAICompat(apiKey, system, messages, model, "https://api.openai.com/v1");
  }
}

async function* streamClaude(
  apiKey: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  model: string,
): AsyncGenerator<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (res.status === 402) throw new Error("Your Claude API balance has run out. Add credits at console.anthropic.com.");
  if (res.status === 401) throw new Error("Invalid Claude API key. Replace it in Settings → AI.");
  if (res.status === 429) throw new Error("Claude rate limit reached. Try again in a moment.");
  if (!res.ok) throw new Error(`Claude API error (${res.status})`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            yield parsed.delta.text;
          }
        } catch { /* skip non-JSON lines */ }
      }
    }
  }
}

async function* streamOpenAICompat(
  apiKey: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  model: string,
  baseUrl: string,
): AsyncGenerator<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (res.status === 402) throw new Error("Your API balance has run out. Add credits to your account.");
  if (res.status === 401) throw new Error("Invalid API key. Replace it in Settings → AI.");
  if (res.status === 429) throw new Error("Rate limit reached. Try again in a moment.");
  if (!res.ok) throw new Error(`API error (${res.status})`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch { /* skip */ }
      }
    }
  }
}

async function* streamGemini(
  apiKey: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  model: string,
): AsyncGenerator<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

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
      generationConfig: { maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (res.status === 402 || res.status === 429) throw new Error("Gemini quota exceeded. Check your usage at aistudio.google.com.");
  if (res.status === 401 || res.status === 403) throw new Error("Invalid Gemini API key. Replace it in Settings → AI.");
  if (!res.ok) throw new Error(`Gemini API error (${res.status})`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;
        } catch { /* skip */ }
      }
    }
  }
}
