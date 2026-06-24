/**
 * GET /api/conversations/[id] — full thread.
 *
 * Returns:
 *   * `conversation`  — the conversations row.
 *   * `alert`         — anchor alert when present (Mode A right panel).
 *   * `messages`      — chronological messages (capped 500).
 *
 * Inari Live V1 Session 5.
 */

import { NextRequest } from "next/server";

import { getConversation } from "@/lib/services/conversations.service";
import { authorizeConversationCtx } from "../_authorize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
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
  const result = await getConversation(id, {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
  });
  if (!result) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return Response.json(result);
}
