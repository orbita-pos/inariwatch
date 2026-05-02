import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUserProjectIds } from "@/lib/db";
import { getUserAIKey } from "@/lib/ai/get-key";
import { resolveModel } from "@/lib/ai/models";
import { gatherChatContext, buildContextString, SYSTEM_OPS } from "@/lib/services/chat.service";
import { assertWithinQuota, incrementQuota, QuotaExceededError } from "@/lib/ai/quota";
import { dispatchStream, TASKS } from "@inariwatch/ai-router";

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let streamOk = false;
      try {
        const chatModel = resolveModel("chat", aiKey.provider, aiKey.modelPrefs);
        const it = dispatchStream({
          mode: "stream",
          task: TASKS.CHAT_CONVERSATIONAL,
          apiKey: aiKey.key,
          systemPrompt: SYSTEM_OPS,
          messages: aiMessages,
          maxTokens: 1024,
          model: chatModel,
          timeout: 60_000,
          workspace: { userId, isPlatformKey: aiKey.isPlatformKey },
        });
        for await (const chunk of it) {
          if (chunk.delta) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ content: chunk.delta })}\n\n`),
            );
          }
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
