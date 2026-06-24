/**
 * GET /api/projects/{projectId}/event-stream
 *
 * Inari Live V1 — Session 3. Server-Sent Events stream the wizard
 * (web + desktop) subscribes to during the Add-Project loop:
 *
 *   * `state` — every time the project's wizard state advances
 *   * `first_event` — when the first event (test or real) lands in
 *     the capture pipeline
 *   * `heartbeat` — every 15s so a flat-lined connection clears
 *     intermediate proxies (Cloudflare, browser SW)
 *
 * Implementation: in-process subscription to `lib/projects/event-bus`
 * (no DB poll for the fast path) + a 5s safety poll that catches
 * cross-instance writes the bus missed (Vercel multi-region). The
 * combination keeps the happy-path latency at ~50ms while still
 * delivering eventually for split-instance scenarios.
 *
 * Auth: dual-mode same as sync-vercel-env. Wizard caller (desktop) uses
 * Bearer; the dashboard (web) uses NextAuth session.
 *
 * Lifecycle: closes on client disconnect (`req.signal.aborted`) +
 * a 30-minute hard cap so leaks can't accumulate. The wizard
 * reconnects on its own on close — SSE supports that natively via
 * EventSource's auto-retry.
 */

import { NextRequest } from "next/server";

import { authorizeProjectForTokens } from "../tokens/_authorize";
import {
  getProjectState,
  type ProjectState,
} from "@/lib/projects/state";
import {
  type ProjectEvent,
  subscribeProjectEvents,
} from "@/lib/projects/event-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;
const HARD_CAP_MS = 30 * 60 * 1000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const auth = await authorizeProjectForTokens(projectId);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const initial = await getProjectState(auth.projectId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastSeenState: ProjectState | null = initial;
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

      // Initial snapshot — clients render off this without waiting for
      // the first transition to land.
      sendEvent("connected", { state: initial, at: new Date().toISOString() });

      // Hot path: in-process bus.
      const unsubscribe = subscribeProjectEvents(auth.projectId, (event: ProjectEvent) => {
        if (event.type === "project.state.changed") {
          lastSeenState = event.state as ProjectState;
          sendEvent("state", { state: event.state, at: event.at });
        } else if (event.type === "project.first_event_arrived") {
          sendEvent("first_event", { alertId: event.alertId, at: event.at });
        }
      });

      // Safety poll — catches state writes from other Vercel instances.
      const pollHandle = setInterval(async () => {
        if (closed) return;
        try {
          const current = await getProjectState(auth.projectId);
          if (current && current !== lastSeenState) {
            lastSeenState = current;
            sendEvent("state", { state: current, at: new Date().toISOString() });
          }
        } catch {
          // Don't kill the stream on a transient DB failure — the bus
          // will likely catch up and the next poll retries.
        }
      }, POLL_MS);

      const heartbeatHandle = setInterval(() => {
        safeEnqueue(`: heartbeat\n\n`);
      }, HEARTBEAT_MS);

      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(pollHandle);
        clearInterval(heartbeatHandle);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Hard cap so a forgotten browser tab doesn't pin a Node socket
      // forever. EventSource on the client side reconnects within a
      // few seconds, so a 30-min cap is invisible to the user.
      const capHandle = setTimeout(() => teardown(), HARD_CAP_MS);
      void capHandle;

      // Client disconnect — Next 15 surfaces this through req.signal.
      req.signal.addEventListener("abort", () => teardown());

      // Belt-and-suspenders: enforce hard cap independent of timer
      // race conditions. Some host environments fire the timer
      // before the abort event in pathological timing scenarios.
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
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection:      "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
