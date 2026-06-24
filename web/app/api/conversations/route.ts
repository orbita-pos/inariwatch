/**
 * GET  /api/conversations  — sidebar inbox list
 * POST /api/conversations  — create a free chat (no anchor alert)
 *
 * Inari Live V1 Session 5.
 */

import { NextRequest } from "next/server";

import {
  asConversationState,
  createFreeConversation,
  listConversations,
  type ListConversationsFilter,
} from "@/lib/services/conversations.service";
import { authorizeConversationCtx } from "./_authorize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await authorizeConversationCtx();
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const stateParam = url.searchParams.get("state");
  const sevParam   = url.searchParams.get("severity");
  const mineParam  = url.searchParams.get("mine");
  const qParam     = url.searchParams.get("q");
  const limitParam = url.searchParams.get("limit");

  const filter: ListConversationsFilter = {
    state:    asConversationState(stateParam) ?? (stateParam === "all" ? "all" : undefined),
    severity: sevParam === "all" || sevParam === "critical" || sevParam === "warning" || sevParam === "info"
      ? sevParam
      : undefined,
    mine:     mineParam === "1" || mineParam === "true",
    q:        qParam ?? undefined,
    limit:    limitParam ? Math.max(1, Math.min(100, Number.parseInt(limitParam, 10) || 50)) : undefined,
  };

  const rows = await listConversations(
    { userId: auth.userId, workspaceId: auth.workspaceId },
    filter,
  );
  return Response.json({ conversations: rows });
}

export async function POST(req: NextRequest) {
  const auth = await authorizeConversationCtx();
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { title?: string; deviceId?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const title = (body.title ?? "").trim();
  if (!title) {
    return new Response(JSON.stringify({ error: "title required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const conv = await createFreeConversation(
    {
      userId:      auth.userId,
      workspaceId: auth.workspaceId,
      deviceId:    body.deviceId ?? null,
    },
    { title },
  );

  return Response.json({ conversation: conv });
}
