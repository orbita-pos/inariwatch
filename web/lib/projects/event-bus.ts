/**
 * Project event bus — Inari Live V1 Session 3.
 *
 * Tiny in-process pub/sub that the SSE stream
 * (/api/projects/[projectId]/event-stream) subscribes to so it can push
 * state transitions and "first event arrived" notifications to web +
 * desktop clients without polling Postgres on every tick.
 *
 * Trade-off (intentional, V1):
 * The bus lives ONLY in the current Node process. On Vercel that means
 * a state transition emitted by an /api route in instance A doesn't
 * directly notify SSE listeners in instance B. We accept that for V1
 * because:
 *   1. The capture webhook + the wizard's mint/sync/transition calls
 *      both originate from /api routes — Vercel routes them by URL
 *      hash, so within the same project's request envelope everything
 *      tends to land on the same instance.
 *   2. The SSE stream falls back to a 2s DB poll for state changes the
 *      bus missed (out-of-process write). The bus is the fast path,
 *      the poll is the floor.
 *   3. V1.5 swaps this for Redis pub/sub via `lib/redis.ts` once
 *      proven necessary by telemetry.
 *
 * Listeners are keyed by `projectId` so an SSE connection only sees
 * its project's events. The map auto-cleans empty buckets on
 * unsubscribe so a long-lived dyno doesn't leak listeners after a
 * thousand wizard sessions.
 */

export type ProjectEvent =
  | { type: "project.state.changed"; state: string; at: string }
  | { type: "project.first_event_arrived"; alertId: string; at: string };

type Listener = (event: ProjectEvent) => void;

const listeners = new Map<string, Set<Listener>>();

/**
 * Subscribe to events for a single project. Returns an unsubscribe
 * function — caller MUST invoke it on disconnect (SSE `cancel`,
 * test cleanup, etc.) to keep the listener map bounded.
 */
export function subscribeProjectEvents(projectId: string, listener: Listener): () => void {
  let bucket = listeners.get(projectId);
  if (!bucket) {
    bucket = new Set();
    listeners.set(projectId, bucket);
  }
  bucket.add(listener);
  return () => {
    const b = listeners.get(projectId);
    if (!b) return;
    b.delete(listener);
    if (b.size === 0) listeners.delete(projectId);
  };
}

/**
 * Fire an event to every listener for the given project. Listener
 * exceptions are swallowed individually so one buggy subscriber can't
 * starve the others.
 */
export function publishProjectEvent(projectId: string, event: ProjectEvent): void {
  const bucket = listeners.get(projectId);
  if (!bucket || bucket.size === 0) return;
  for (const listener of bucket) {
    try {
      listener(event);
    } catch {
      /* noop — bus drops bad subscribers silently. */
    }
  }
}

/** Test-only: clear all listeners. Production code never needs this. */
export function __resetProjectEventBusForTests(): void {
  listeners.clear();
}

/** Test-only: peek at the current listener count for a project. */
export function __projectEventListenerCountForTests(projectId: string): number {
  return listeners.get(projectId)?.size ?? 0;
}
