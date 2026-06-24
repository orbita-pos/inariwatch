/**
 * GET /api/conversations/event-stream
 *
 * Workspace-level SSE: drives the sidebar inbox. Emits:
 *   * `connected`        — initial envelope.
 *   * `created`          — new conversation (from alert auto-create or
 *                          a free-chat POST).
 *   * `state`            — state transitions, so the sidebar moves rows
 *                          between groups (Active / Snoozed / Resolved).
 *   * `heartbeat`        — every 15s.
 *
 * Per-message events are *not* fanned out here to keep sidebar update
 * cost bounded — the conversation pane has its own per-conversation
 * stream for that. The sidebar only re-renders when a new row appears
 * or its state changes.
 *
 * Inari Live V1 Session 5.
 */

import { NextRequest } from "next/server";

import { subscribeWorkspaceEvents } from "@/lib/services/conversations.service";
import { SOLO_WORKSPACE_KEY } from "@/lib/conversations/event-bus";
import { authorizeConversationCtx } from "../_authorize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;
const HARD_CAP_MS  = 30 * 60 * 1000;

export async function GET(req: NextRequest) {
  const auth = await authorizeConversationCtx();
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Workspace=null is a valid scope ("legacy single-org install"); we
  // key the bucket on the SOLO sentinel so all such users share one
  // channel. Users with explicit workspaces get isolated streams.
  const workspaceKey = auth.workspaceId ?? SOLO_WORKSPACE_KEY;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const startedAt = Date.now();
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { closed = true; }
      };
      const sendEvent = (eventName: string, data: unknown) => {
        safeEnqueue(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent("connected", { workspaceId: auth.workspaceId, at: new Date().toISOString() });

      const unsubscribe = subscribeWorkspaceEvents(workspaceKey, (event) => {
        if (event.type === "conversation.created") {
          sendEvent("created", event);
        } else if (event.type === "conversation.state_changed") {
          sendEvent("state", event);
        }
        // conversation.message intentionally skipped at workspace level.
      });

      const heartbeatHandle = setInterval(() => {
        safeEnqueue(`: heartbeat\n\n`);
      }, HEARTBEAT_MS);

      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeatHandle);
        try { controller.close(); } catch { /* noop */ }
      };

      setTimeout(() => teardown(), HARD_CAP_MS);
      req.signal.addEventListener("abort", () => teardown());
      const lifeWatcher = setInterval(() => {
        if (Date.now() - startedAt > HARD_CAP_MS) {
          clearInterval(lifeWatcher);
          teardown();
        }
      }, 60_000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache, no-transform",
      Connection:          "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
