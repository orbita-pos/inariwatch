/**
 * POST /api/conversations/[id]/messages — append user message.
 *
 * Stamps the witness chain server-side and broadcasts the new message
 * via the SSE event stream. Body shape: `{ content, deviceId? }`.
 *
 * Inari Live V1 Session 5.
 */

import { NextRequest } from "next/server";

import { postUserMessage } from "@/lib/services/conversations.service";
import { authorizeConversationCtx } from "../../_authorize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authorizeConversationCtx();
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { content?: string; deviceId?: string; meta?: Record<string, unknown> } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const text = (body.content ?? "").trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "content required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const message = await postUserMessage(
      id,
      {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        deviceId: body.deviceId ?? null,
      },
      { text, meta: body.meta },
    );
    return Response.json({ message });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to post message";
    const status = /not found/i.test(msg) ? 404 : /forbidden/i.test(msg) ? 403 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
