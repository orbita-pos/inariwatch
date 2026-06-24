/**
 * GET /api/conversations/[id]/event-stream
 *
 * SSE stream for a single conversation. Pushes:
 *   * `connected`       — initial snapshot envelope.
 *   * `message`         — every new message (across devices).
 *   * `state`           — state transitions (snooze / resolve / reopen).
 *   * `heartbeat`       — every 15s so flat-lined connections clear
 *                         intermediate proxies (Cloudflare, browser SW).
 *
 * Auth: dual-mode like the rest of the conversations API.
 *
 * Lifecycle: closes on client disconnect (`req.signal.aborted`) +
 * a 30-minute hard cap so leaks can't accumulate. Web `EventSource`
 * auto-reconnects within seconds, so the cap is invisible to users.
 *
 * Inari Live V1 Session 5.
 */

import { NextRequest } from "next/server";

import {
  getConversation,
  subscribeConversationEvents,
} from "@/lib/services/conversations.service";
import { authorizeConversationCtx } from "../../_authorize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;
const HARD_CAP_MS  = 30 * 60 * 1000;

export async function GET(
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

  // Authorize against the conversation (workspace check).
  const initial = await getConversation(id, {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
  });
  if (!initial) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const startedAt = Date.now();

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const sendEvent = (eventName: string, data: unknown) => {
        safeEnqueue(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent("connected", {
        conversationId: initial.conversation.id,
        state: initial.conversation.state,
        at: new Date().toISOString(),
      });

      const unsubscribe = subscribeConversationEvents(id, (event) => {
        if (event.type === "conversation.message") {
          sendEvent("message", event);
        } else if (event.type === "conversation.state_changed") {
          sendEvent("state", event);
        }
      });

      const heartbeatHandle = setInterval(() => {
        safeEnqueue(`: heartbeat\n\n`);
      }, HEARTBEAT_MS);

      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeatHandle);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const capHandle = setTimeout(() => teardown(), HARD_CAP_MS);
      void capHandle;

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
