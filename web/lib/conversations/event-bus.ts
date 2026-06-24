/**
 * Conversation event bus — Inari Live V1 Session 5.
 *
 * Tiny in-process pub/sub for the conversation SSE stream. Mirrors
 * `lib/projects/event-bus.ts` deliberately — same trade-offs, same
 * Vercel-multi-instance caveats:
 *
 *   1. Bus lives only in the current Node process; cross-instance
 *      writes get caught by the SSE route's safety poll (every 5s).
 *   2. V1.5 swaps for Redis pub/sub via `lib/redis.ts`.
 *
 * Two listener flavours so the sidebar (workspace-level) and the
 * conversation pane (per-conversation) can both stay reactive without
 * subscribing to a fire-hose:
 *
 *   * `subscribeConversationEvents(conversationId, listener)` — message
 *     + state events for a single conversation.
 *   * `subscribeWorkspaceEvents(workspaceId, listener)` — created +
 *     state events for the entire inbox. Skips per-message events to
 *     keep the sidebar update cost bounded.
 *
 * Listener exceptions are swallowed individually so one buggy
 * subscriber can't starve the others.
 */

export type ConversationEvent =
  | {
      type: "conversation.created";
      conversationId: string;
      anchorAlertId: string | null;
      title: string;
      state: string;
      workspaceId: string | null;
      at: string;
    }
  | {
      type: "conversation.message";
      conversationId: string;
      message: {
        id: string;
        role: string;
        content: unknown;
        createdAt: string;
        deviceId: string | null;
        toolCallId: string | null;
      };
      at: string;
    }
  | {
      type: "conversation.state_changed";
      conversationId: string;
      state: string;
      at: string;
    };

type Listener = (event: ConversationEvent) => void;

const conversationListeners = new Map<string, Set<Listener>>();
const workspaceListeners    = new Map<string, Set<Listener>>();

export function subscribeConversationEvents(
  conversationId: string,
  listener: Listener,
): () => void {
  return subscribe(conversationListeners, conversationId, listener);
}

export function subscribeWorkspaceEvents(
  workspaceId: string,
  listener: Listener,
): () => void {
  return subscribe(workspaceListeners, workspaceId, listener);
}

function subscribe(
  bucket: Map<string, Set<Listener>>,
  key: string,
  listener: Listener,
): () => void {
  let bag = bucket.get(key);
  if (!bag) {
    bag = new Set();
    bucket.set(key, bag);
  }
  bag.add(listener);
  return () => {
    const b = bucket.get(key);
    if (!b) return;
    b.delete(listener);
    if (b.size === 0) bucket.delete(key);
  };
}

/** Sentinel key for legacy "single-org" installs where workspaceId is null. */
export const SOLO_WORKSPACE_KEY = "__solo__";

/**
 * Fire an event to:
 *   * Every listener for `conversationId`.
 *   * Every workspace listener for the row's bucket — `workspaceId` or
 *     SOLO_WORKSPACE_KEY for legacy null-workspace rows. Per-message
 *     events are skipped at the workspace level so the sidebar update
 *     cost stays bounded; sidebars re-render on `created`/`state_changed`.
 */
export function publishConversationEvent(
  event: ConversationEvent,
  workspaceId: string | null,
): void {
  fireFromBucket(conversationListeners.get(event.conversationId), event);
  if (event.type !== "conversation.message") {
    const wsKey = workspaceId ?? SOLO_WORKSPACE_KEY;
    fireFromBucket(workspaceListeners.get(wsKey), event);
  }
}

function fireFromBucket(bucket: Set<Listener> | undefined, event: ConversationEvent): void {
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
export function __resetConversationEventBusForTests(): void {
  conversationListeners.clear();
  workspaceListeners.clear();
}

/** Test-only: peek at conversation listener count. */
export function __conversationListenerCountForTests(conversationId: string): number {
  return conversationListeners.get(conversationId)?.size ?? 0;
}

/** Test-only: peek at workspace listener count. */
export function __workspaceListenerCountForTests(workspaceId: string): number {
  return workspaceListeners.get(workspaceId)?.size ?? 0;
}
