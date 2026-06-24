/**
 * S12 — POST /api/mobile/chat/stream  (SSE)
 *
 * Streaming version of /api/mobile/chat. Same shape, same auth, but
 * the body is sent as `text/event-stream` chunks for typing-style UI.
 */

import { type NextRequest } from "next/server";
import { db, projects, organizations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { authoriseMobileRequest } from "@/lib/auth/mobile-auth";
import {
  gatherChatContext,
  buildContextString,
  SYSTEM_OPS,
} from "@/lib/services/chat.service";
import { getUserAIKey } from "@/lib/ai/get-key";
import { resolveModel } from "@/lib/ai/models";
import { dispatchStream, TASKS } from "@inariwatch/ai-router";
import { rateLimit } from "@/lib/auth-rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await authoriseMobileRequest(req);
  if (!auth.ok) return auth.response;
  const { device } = auth;

  const rl = await rateLimit("mobile-chat", device.deviceId, { windowMs: 60_000, max: 30 });
  if (!rl.allowed) {
    return Response.json(
      { error: "rate_limited", retry_after_seconds: rl.retryAfterSeconds ?? 60 },
      { status: 429 },
    );
  }

  let body: { prompt?: unknown };
  try {
    body = (await req.json()) as { prompt?: unknown };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (prompt.length === 0 || prompt.length > 4000) {
    return Response.json({ error: "invalid_prompt" }, { status: 400 });
  }

  const orgRows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, device.workspaceId))
    .limit(1);
  if (orgRows.length === 0) {
    return Response.json({ error: "workspace_not_found" }, { status: 404 });
  }
  const ownerUserId = orgRows[0].ownerId;
  const aiKey = await getUserAIKey(ownerUserId);

  const projRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, device.workspaceId));
  const projectIds = projRows.map((p) => p.id);
  const ctx = await gatherChatContext(projectIds);
  const context = buildContextString(ctx);
  const aiMessages = [
    {
      role: "user" as const,
      content: `${context}\n\n---\n\nUser question (from mobile, device "${device.displayName}"): ${prompt}`,
    },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      if (!aiKey) {
        send({ content: "AI is temporarily unavailable. Ask the workspace owner to add an AI key in Settings." });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      try {
        const chatModel = resolveModel("chat", aiKey.provider, aiKey.modelPrefs);
        const it = dispatchStream({
          mode:         "stream",
          task:         TASKS.CHAT_CONVERSATIONAL,
          apiKey:       aiKey.key,
          systemPrompt: SYSTEM_OPS,
          messages:     aiMessages,
          maxTokens:    1024,
          model:        chatModel,
          timeout:      60_000,
          workspace:    { userId: ownerUserId, isPlatformKey: aiKey.isPlatformKey },
        });
        for await (const chunk of it) {
          if (chunk.delta) send({ content: chunk.delta });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        send({ error: e instanceof Error ? e.message : "AI error" });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection:      "keep-alive",
    },
  });
}
