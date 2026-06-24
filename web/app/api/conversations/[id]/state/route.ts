/**
 * POST /api/conversations/[id]/state — snooze / resolve / reopen / archive.
 *
 * Body: `{ state, snoozedUntil?, resolutionSummary? }`.
 *
 * Inari Live V1 Session 5.
 */

import { NextRequest } from "next/server";

import {
  asConversationState,
  setConversationState,
} from "@/lib/services/conversations.service";
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

  let body: {
    state?: string;
    snoozedUntil?: string;
    resolutionSummary?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const state = asConversationState(body.state);
  if (!state) {
    return new Response(JSON.stringify({ error: "invalid state" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let snoozedUntil: Date | null = null;
  if (state === "snoozed") {
    if (!body.snoozedUntil) {
      return new Response(JSON.stringify({ error: "snoozedUntil required for state=snoozed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const ts = Date.parse(body.snoozedUntil);
    if (Number.isNaN(ts)) {
      return new Response(JSON.stringify({ error: "snoozedUntil must be ISO timestamp" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    snoozedUntil = new Date(ts);
  }

  try {
    const conv = await setConversationState(
      id,
      { userId: auth.userId, workspaceId: auth.workspaceId },
      {
        state,
        snoozedUntil,
        resolutionSummary: body.resolutionSummary ?? null,
      },
    );
    return Response.json({ conversation: conv });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update state";
    const status = /Invalid transition/i.test(msg) ? 409 :
                   /not found/i.test(msg)         ? 404 :
                   /forbidden/i.test(msg)         ? 403 : 400;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
