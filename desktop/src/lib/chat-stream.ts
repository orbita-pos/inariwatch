/**
 * Chat streaming pipeline.
 *
 * Sesión 18 wires the real path: the desktop's `start_chat_stream`
 * IPC command opens an OpenAI streaming connection from Rust and
 * publishes one `ChatTokenStream { session_id, token, finish_reason }`
 * variant of `DaemonEvent` per token. The dock subscribes to
 * `daemon:event`, filters by the session id it dispatched, and feeds
 * deltas into `useChat.appendToken` / `useChat.finishStreaming`.
 *
 * Backwards compatibility: the `mockStream` fallback stays for the
 * jsdom/Vite-preview case where Tauri isn't available, AND for the
 * "command not registered yet" branch (so a dev build of the dock
 * against an older daemon binary still paints something instead of
 * hanging the assistant message).
 */

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { onDaemonEvent } from "@/lib/ipc";
import { setStreamDriver, useChat } from "@/lib/store/chat";

const MOCK_TOKEN_INTERVAL_MS = 50;
const MOCK_RESPONSE = [
  "I",
  " looked",
  " through",
  " the",
  " stack",
  " trace",
  " and",
  " the",
  " latest",
  " commit",
  ".",
  "\n\n",
  "The",
  " auth",
  " middleware",
  " is",
  " missing",
  " a",
  " session",
  " refresh",
  " before",
  " the",
  " redirect",
  " — ",
  " here",
  "'s",
  " the",
  " patch",
  " I",
  " would",
  " apply",
  ":\n\n",
  "```ts\n",
  "// web/middleware.ts\n",
  "if (!session) {\n",
  "  return NextResponse.redirect(loginUrl);\n",
  "}\n",
  "```\n\n",
  "Once",
  " applied",
  ",",
  " the",
  " redirect",
  " loop",
  " stops",
  ".",
  " Want",
  " me",
  " to",
  " open",
  " the",
  " diff",
  "?",
];

/**
 * Wire shape of the Sesión-18 `ChatTokenStream` daemon-event variant.
 * `session_id` echoes the messageId the dock dispatched the IPC with;
 * `finish_reason` is `Some(_)` only on the closing event.
 *
 * Older daemon builds emitted `messageId`/`done` placeholders during
 * Sesión 15 — both shapes are accepted so rolling daemon downgrades
 * don't strand the dock UI.
 */
interface ChatTokenStreamEvent {
  kind: "chat_token_stream";
  session_id?: string;
  message_id?: string;
  messageId?: string;
  token?: string;
  finish_reason?: string | null;
  done?: boolean;
}

function isChatTokenStream(value: unknown): value is ChatTokenStreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === "chat_token_stream";
}

/**
 * Fire-and-forget mock streamer. Emitted from the fallback paths
 * (no Tauri runtime + Tauri runtime where the IPC command isn't
 * registered yet) so the dock UX never hangs on a stale spinner.
 */
function mockStream(
  messageId: string,
  _prompt: string,
  intervalMs: number = MOCK_TOKEN_INTERVAL_MS,
): void {
  let i = 0;
  const tick = () => {
    if (i >= MOCK_RESPONSE.length) {
      useChat.getState().finishStreaming(messageId);
      return;
    }
    useChat.getState().appendToken(messageId, MOCK_RESPONSE[i]!);
    i += 1;
    setTimeout(tick, intervalMs);
  };
  tick();
}

/**
 * Detect whether `start_chat_stream` is a registered Tauri command on
 * the running daemon. Older builds (pre-Sesión-18) reject the invoke
 * with a message containing "not found"; we degrade to the mock path
 * in that case rather than hanging the assistant turn.
 */
function isCommandNotFoundError(err: unknown): boolean {
  if (err == null) return false;
  const msg = typeof err === "string" ? err : (err as { message?: string }).message ?? String(err);
  return /command\s+(?:.*\s+)?(?:not\s+found|not\s+registered|unknown)/i.test(msg);
}

/**
 * Install the chat streaming driver. Resolution order:
 *   1. Tauri runtime + `start_chat_stream` registered → real path. The
 *      `daemon:event` listener forwards `ChatTokenStream` deltas.
 *   2. Tauri runtime, command rejected as "not found" → fall through
 *      to the mock for that one message so the UI doesn't stall.
 *   3. No Tauri runtime → mock path always.
 *
 * Returns an unlisten that components MUST call on unmount.
 */
export async function installChatStreamDriver(): Promise<UnlistenFn> {
  const tauriAvailable = typeof window !== "undefined" && "__TAURI__" in window;

  setStreamDriver((messageId, prompt) => {
    if (!tauriAvailable) {
      mockStream(messageId, prompt);
      return;
    }
    // Real path. The daemon will publish ChatTokenStream events
    // tagged with `session_id === messageId`; the listener installed
    // below routes them into the chat store.
    invoke<void>("start_chat_stream", {
      args: {
        session_id: messageId,
        prompt,
        repo_id: useChat.getState().sessionId,
      },
    }).catch((err: unknown) => {
      if (isCommandNotFoundError(err)) {
        // Daemon predates Sesión 18 — mock the response so the user
        // gets *something* instead of a hung spinner.
        mockStream(messageId, prompt);
        return;
      }
      // Real backend failure (no key, budget cap, network). Append a
      // single error sentence + close the stream.
      useChat.getState().appendToken(
        messageId,
        `\n_chat error: ${err instanceof Error ? err.message : String(err)}_`,
      );
      useChat.getState().finishStreaming(messageId);
    });
  });

  if (!tauriAvailable) {
    return () => {
      setStreamDriver(null);
    };
  }

  const unlisten = await onDaemonEvent((event) => {
    if (!isChatTokenStream(event)) return;
    // Match either the new wire field (`session_id`) or the
    // pre-Sesión-18 placeholder names so older daemon builds still
    // paint correctly.
    const messageId =
      event.session_id ?? event.message_id ?? event.messageId;
    if (!messageId) return;

    if (typeof event.token === "string" && event.token.length > 0) {
      useChat.getState().appendToken(messageId, event.token);
    }

    // Stream end signalled either by `finish_reason` (Sesión 18) or
    // the legacy `done: true` boolean.
    const finished =
      (typeof event.finish_reason === "string" && event.finish_reason.length > 0) ||
      event.done === true;
    if (finished) {
      useChat.getState().finishStreaming(messageId);
    }
  });

  return () => {
    unlisten();
    setStreamDriver(null);
  };
}

/**
 * Test-only entrypoint — installs `mockStream` directly with a fast
 * tick interval, no Tauri probing. Used by `DockConversation.test.tsx`
 * to drive the streaming render path deterministically.
 */
export function installMockStreamForTests(intervalMs: number = 5): void {
  setStreamDriver((messageId, prompt) => {
    mockStream(messageId, prompt, intervalMs);
  });
}
