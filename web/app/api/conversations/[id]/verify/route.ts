/**
 * POST /api/conversations/[id]/verify — chain-level Witness verify.
 *
 * Walks the conversation's full message log, recomputes
 * `prev → message_hash` for each row, returns:
 *   * { ok: true, totalMessages }
 *   * { ok: false, totalMessages, firstBreakAt: { messageId, reason, expected, actual } }
 *
 * Carries the deferred-from-slash session per the V1 plan.
 *
 * Inari Live V1 Session 5.
 */

import { NextRequest } from "next/server";

import {
  getConversation,
  verifyConversationChain,
} from "@/lib/services/conversations.service";
import { authorizeConversationCtx } from "../../_authorize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
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

  // Authorize against the conversation (workspace match).
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

  const verify = await verifyConversationChain(id);
  return Response.json(verify);
}
