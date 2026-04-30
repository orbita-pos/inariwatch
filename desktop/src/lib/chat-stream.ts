/**
 * Chat streaming pipeline.
 *
 * Sesión 15 wires two paths:
 *   1. The real `daemon:event` listener for `ChatTokenStream { sessionId,
 *      messageId, token, done }`. Sesión 18 ports the OpenAI client into
 *      the daemon and starts emitting that variant.
 *   2. A `mockStream` fallback used until Sesión 18 lands. Emits a canned
 *      response token-by-token at a fixed cadence, mimicking the real
 *      stream cadence well enough that the dock UI (auto-scroll, tool
 *      call layout) gets exercised in the absence of a backend.
 *
 * The component layer doesn't pick — it calls `installChatStreamDriver()`
 * once on mount and the resolver below picks the live listener if the
 * runtime supports it, else the mock.
 */

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
 * Forward-compat shape — Sesión 18 will add the matching variant to
 * `DaemonEvent` in `lib/ipc.ts`. Until then we treat it as a structural
 * read against the open variant union.
 */
interface ChatTokenStreamEvent {
  kind: "chat_token_stream";
  message_id?: string;
  messageId?: string;
  token?: string;
  done?: boolean;
}

function isChatTokenStream(value: unknown): value is ChatTokenStreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === "chat_token_stream";
}

/**
 * Fire-and-forget mock streamer. Tokens are emitted on a `setTimeout`
 * cadence so the UI gets a realistic visual signal. Returns the timer
 * handle for cleanup but the component doesn't need to track it — the
 * stream runs to completion in well under 3s.
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
 * Install the chat streaming driver. Resolution order:
 *   1. Real Tauri runtime → subscribe to `daemon:event` for
 *      `ChatTokenStream`. Token push happens in the listener.
 *   2. No Tauri runtime (jsdom in tests, Vite dev preview, web preview)
 *      → wire `mockStream` as the driver.
 *
 * Returns an unlisten that components MUST call on unmount.
 */
export async function installChatStreamDriver(): Promise<UnlistenFn> {
  const tauriAvailable = typeof window !== "undefined" && "__TAURI__" in window;

  // Set the per-message driver — used both in tauri AND mock paths so
  // `useChat.sendMessage` dispatches consistently.
  setStreamDriver((messageId, prompt) => {
    if (tauriAvailable) {
      // Real path: the daemon will emit ChatTokenStream events tagged
      // with this messageId once Sesión 18 ports the OpenAI client.
      // Sesión 15 leaves the listener installed; in the meantime the
      // assistant message stays empty + streaming until the listener
      // finishes it. To avoid a "stuck spinner" demo, fall through to
      // the mock below until the variant actually shows up on the bus.
      mockStream(messageId, prompt);
      return;
    }
    mockStream(messageId, prompt);
  });

  if (!tauriAvailable) {
    // No Tauri to listen on — return a no-op unlisten.
    return () => {
      setStreamDriver(null);
    };
  }

  const unlisten = await onDaemonEvent((event) => {
    if (!isChatTokenStream(event)) return;
    const messageId = event.messageId ?? event.message_id;
    if (!messageId) return;
    if (typeof event.token === "string" && event.token.length > 0) {
      useChat.getState().appendToken(messageId, event.token);
    }
    if (event.done) {
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
