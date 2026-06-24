/**
 * S12 — POST /api/mobile/chat
 *
 * Bearer = device JWT. Body `{ alert_id?, prompt }`. We delegate
 * straight to `chat.service` (the same path the dashboard /api/chat
 * uses) — no new AI loop, no new prompts.
 *
 * For non-streamed clients, this returns a single JSON response.
 * Streaming UX uses `/api/mobile/chat/stream` (SSE) instead.
 */

import { NextResponse, type NextRequest } from "next/server";
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

interface ChatBody {
  prompt?:    unknown;
  alert_id?:  unknown;
  history?:   unknown;
}

export async function POST(req: NextRequest) {
  const auth = await authoriseMobileRequest(req);
  if (!auth.ok) return auth.response;
  const { device } = auth;

  const rl = await rateLimit("mobile-chat", device.deviceId, { windowMs: 60_000, max: 30 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: rl.retryAfterSeconds ?? 60 },
      { status: 429 },
    );
  }

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (prompt.length === 0 || prompt.length > 4000) {
    return NextResponse.json({ error: "invalid_prompt" }, { status: 400 });
  }

  const orgRows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, device.workspaceId))
    .limit(1);
  if (orgRows.length === 0) {
    return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });
  }
  const ownerUserId = orgRows[0].ownerId;

  const aiKey = await getUserAIKey(ownerUserId);
  if (!aiKey) {
    return NextResponse.json({
      role: "assistant",
      content: "AI is temporarily unavailable. Ask the workspace owner to add an AI key in Settings.",
    });
  }

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

  const chatModel = resolveModel("chat", aiKey.provider, aiKey.modelPrefs);
  let assembled = "";
  try {
    const it = dispatchStream({
      mode:        "stream",
      task:        TASKS.CHAT_CONVERSATIONAL,
      apiKey:      aiKey.key,
      systemPrompt: SYSTEM_OPS,
      messages:    aiMessages,
      maxTokens:   1024,
      model:       chatModel,
      timeout:     60_000,
      workspace:   { userId: ownerUserId, isPlatformKey: aiKey.isPlatformKey },
    });
    for await (const chunk of it) {
      if (chunk.delta) assembled += chunk.delta;
    }
  } catch (e) {
    return NextResponse.json({
      role:    "assistant",
      content: e instanceof Error ? e.message : "AI error",
      error:   true,
    });
  }
  return NextResponse.json({ role: "assistant", content: assembled });
}
