/**
 * Chat streaming pipeline.
 *
 * Phase 3 of the pure-slash refactor (2026-05-15) removed the cloud
 * free-chat path; Phase 4.6 deleted the `start_chat_stream` Tauri
 * command outright (it had stuck around for one release cycle as a
 * deprecation stub). Any frontend bundle still trying to `invoke
 * "start_chat_stream"` now gets a "command not found" error — but
 * production has no such caller, the dock input is a slash-only
 * command bar.
 *
 * The driver below now only services two paths:
 *
 *   1. `mockStream` for jsdom/Vite-preview where Tauri isn't available
 *      (used by tests and headless renders so the assistant bubble
 *      doesn't spin forever).
 *   2. `local_ai_infer` for the opt-in offline-mode chat (`Settings →
 *      AI → Local AI`). That feature is intentionally orthogonal to
 *      the pure-slash architecture — it stays on-device and the input
 *      surface is whatever the user wires it to.
 *
 * For Tauri-runtime + local-AI-off the driver finalizes the assistant
 * message immediately. Legitimate user interactions never reach this
 * branch in production because `DockConversation.onSubmit` rejects
 * non-slash text before calling `sendMessage`; this is purely a
 * safety net for any remaining inline-action button (e.g.
 * `ChatMessage.InlineActionRow`'s "Apply that fix.") that still
 * dispatches a canned prompt through `sendMessage`.
 *
 * The `daemon:event` listener is kept registered because the local
 * AI path emits its own `local-ai-*` events outside the bus and the
 * mock streamer doesn't use it — but other surfaces still consume
 * the bus, and tearing the listener down here would be invasive.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { applyOutcomeToStore } from "@/components/ToolCallCard";
import { onDaemonEvent } from "@/lib/ipc";
import { userMemoryExtract } from "@/lib/ipc/user-memory";
import { setStreamDriver, useChat } from "@/lib/store/chat";
import { useSettings } from "@/lib/store/settings";
import { desktopToolInvoke } from "@/lib/tool-invoke-ipc";

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

/**
 * S6 — assembled tool call emitted by `streaming.rs::stream_to_bus`
 * when the LLM closes a stream with `finish_reason == "tool_calls"`.
 * One event per call; the listener invokes `desktop_tool_invoke` and
 * patches the resulting outcome onto the chat store.
 */
interface ChatToolCallEvent {
  kind: "chat_tool_call";
  session_id?: string;
  tool_call_id?: string;
  name?: string;
  arguments?: string;
}

function isChatTokenStream(value: unknown): value is ChatTokenStreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === "chat_token_stream";
}

function isChatToolCall(value: unknown): value is ChatToolCallEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === "chat_tool_call";
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
 * The `daemon:event` listener is a process-wide singleton. Even with the
 * StrictMode + async-install race fix in place, every re-invocation of
 * `installChatStreamDriver` historically called `listen()` again — and
 * each `listen()` registers an INDEPENDENT handler with Tauri. If any
 * dance leaves a stray subscription alive (HMR + Fast Refresh under dev,
 * a forced re-mount of DockShell, etc.), every chat token gets appended
 * twice — visible to the user as `¡¡HolaHola!!` interleaving per-token.
 *
 * Promoting the listener to a module-level singleton fixes that whole
 * class of bugs at the root: the Tauri subscription is registered on
 * the first install call and reused across every subsequent call. The
 * function the listener invokes (`handleChatStreamEvent`) reads from the
 * live store, so it doesn't matter that it's "old" — it always operates
 * on the current state.
 *
 * We never unsubscribe. The process lifetime IS the listener lifetime;
 * when the app exits the OS reclaims the channel.
 */
let chatListenerInstall: Promise<void> | null = null;

function handleChatStreamEvent(event: unknown): void {
  if (isChatToolCall(event)) {
    handleChatToolCall(event);
    return;
  }
  if (!isChatTokenStream(event)) return;
  // Match either the new wire field (`session_id`) or the pre-Sesión-18
  // placeholder names so older daemon builds still paint correctly.
  const messageId = event.session_id ?? event.message_id ?? event.messageId;
  if (!messageId) return;

  if (typeof event.token === "string" && event.token.length > 0) {
    useChat.getState().appendToken(messageId, event.token);
  }

  // Stream end signalled either by `finish_reason` (Sesión 18) or the
  // legacy `done: true` boolean.
  const finished =
    (typeof event.finish_reason === "string" && event.finish_reason.length > 0) ||
    event.done === true;
  if (finished) {
    useChat.getState().finishStreaming(messageId);
  }
}

async function ensureChatListenerInstalled(): Promise<void> {
  if (chatListenerInstall) return chatListenerInstall;
  chatListenerInstall = (async () => {
    await onDaemonEvent(handleChatStreamEvent);
  })();
  return chatListenerInstall;
}

/**
 * Install the chat streaming driver. Resolution order:
 *   1. No Tauri runtime → mock path (jsdom/Vite-preview only).
 *   2. Tauri runtime + Local AI enabled → `local_ai_infer` Rust IPC,
 *      tokens flow back via `local-ai-token` / `local-ai-done` events.
 *   3. Tauri runtime + Local AI disabled → finalize the bubble empty.
 *      Cloud free chat was removed in Phase 3 of the pure-slash
 *      refactor; the input bar in `DockConversation` rejects non-slash
 *      submissions before they reach `sendMessage`, so this branch is
 *      only hit by legacy callers (e.g. inline message-action buttons
 *      that still send canned prompts — slated for Phase 4 cleanup).
 *
 * Returns an unlisten — a no-op; the daemon-event listener is
 * process-wide (see the singleton block above for the rationale).
 */
export async function installChatStreamDriver(): Promise<UnlistenFn> {
  // `isTauri()` is the official Tauri 2 detection (probes
  // `__TAURI_INTERNALS__` internally). Fall back to `__TAURI__` for
  // jsdom test harnesses that mock the global directly.
  const tauriAvailable =
    isTauri() ||
    (typeof window !== "undefined" && "__TAURI__" in window);

  setStreamDriver((messageId, prompt) => {
    if (!tauriAvailable) {
      mockStream(messageId, prompt);
      return;
    }

    // Jarvis: fire-and-forget — extract user facts from this turn.
    userMemoryExtract(prompt).catch(() => undefined);

    // Local AI path — when the user has enabled offline mode, stream
    // tokens from mistralrs instead of the cloud API. The three events
    // (`local-ai-token`, `local-ai-done`, `local-ai-error`) are emitted
    // directly from Rust and do NOT flow through the `daemon:event` bus.
    const localEnabled = useSettings.getState().ai.local_chat_enabled;
    if (localEnabled) {
      // Wire up one-shot event listeners before firing the invoke so we
      // never miss the first token.
      const stopListeners: Array<() => void> = [];
      Promise.all([
        listen<{ session_id: string; token: string }>("local-ai-token", (ev) => {
          if (ev.payload.session_id !== messageId) return;
          useChat.getState().appendToken(messageId, ev.payload.token);
        }),
        listen<string>("local-ai-done", (ev) => {
          if (ev.payload !== messageId) return;
          useChat.getState().finishStreaming(messageId);
          stopListeners.forEach((fn) => fn());
        }),
        listen<{ session_id: string; error: string }>("local-ai-error", (ev) => {
          if (ev.payload.session_id !== messageId) return;
          useChat.getState().appendToken(messageId, `\n_local AI error: ${ev.payload.error}_`);
          useChat.getState().finishStreaming(messageId);
          stopListeners.forEach((fn) => fn());
        }),
      ]).then(([unlistenToken, unlistenDone, unlistenError]) => {
        stopListeners.push(unlistenToken, unlistenDone, unlistenError);
        invoke<void>("local_ai_infer", { sessionId: messageId, prompt }).catch(
          (err: unknown) => {
            const msg =
              err instanceof Error
                ? err.message
                : typeof err === "object" && err !== null && "message" in err
                ? String((err as { message?: unknown }).message)
                : JSON.stringify(err);
            useChat.getState().appendToken(messageId, `\n_local AI error: ${msg}_`);
            useChat.getState().finishStreaming(messageId);
            stopListeners.forEach((fn) => fn());
          },
        );
      }).catch(() => undefined);
      return;
    }

    // Cloud free chat removed (Phase 3 of pure-slash refactor).
    // Finalize the assistant message so the bubble doesn't spin.
    useChat.getState().finishStreaming(messageId);
  });

  if (!tauriAvailable) {
    // Headless / preview path. Nothing to install — the chat-driver
    // slot is set above and the rest is best-effort.
    return () => {};
  }

  // Idempotent — installs the singleton listener on the first call,
  // returns the same in-flight promise on subsequent calls. Awaiting
  // keeps the existing contract that callers can assume the listener
  // is hot by the time the returned Promise resolves.
  await ensureChatListenerInstalled();

  // No-op unlisten. The listener is process-wide and intentionally
  // never torn down — see the singleton block above for why every
  // previous attempt at per-mount lifecycle produced a duplicate-token
  // regression under some combination of StrictMode, HMR, or repeated
  // dock open/close cycles.
  return () => {};
}

/**
 * S6 — react to a `ChatToolCall` daemon event.
 *
 * The daemon emits one event per assembled tool call (see
 * `desktop/src-tauri/src/ai/streaming.rs::publish_accumulated_tool_calls`).
 * The listener:
 *
 * 1. Adds a `pending` tool-call to the assistant message that owns the
 *    chat session (the daemon's `session_id` IS the assistant
 *    message id — same primitive that ties text deltas to a message).
 * 2. Parses `arguments` (JSON string from the LLM); sets `failed` if
 *    invalid so the user sees the error instead of a hung pending card.
 * 3. Dispatches `desktop_tool_invoke`. The InvokeOutcome is patched
 *    via `applyOutcomeToStore` (shared with the confirm path so the
 *    state-machine logic lives in one place).
 *
 * Errors thrown by the IPC itself (network, schema invalid, unknown
 * tool) flip the card into `failed` with the raw message — same
 * shape as the confirm-button error path.
 */
function handleChatToolCall(event: ChatToolCallEvent): void {
  const messageId = event.session_id;
  const toolCallId = event.tool_call_id;
  const name = event.name;
  if (!messageId || !toolCallId || !name) return;

  const argsStr = event.arguments ?? "";
  let parsedArgs: unknown;
  try {
    parsedArgs = argsStr.length === 0 ? {} : JSON.parse(argsStr);
  } catch (e) {
    useChat.getState().addToolCall(messageId, {
      id: toolCallId,
      name,
      input: argsStr,
      status: "failed",
      error: `model emitted invalid JSON args: ${(e as Error).message}`,
    });
    return;
  }

  useChat.getState().addToolCall(messageId, {
    id: toolCallId,
    name,
    input: parsedArgs,
    status: "pending",
  });

  const sessionId = useChat.getState().sessionId;
  void desktopToolInvoke(name, parsedArgs, sessionId)
    .then((outcome) => {
      applyOutcomeToStore(
        useChat.getState().updateToolCall,
        messageId,
        toolCallId,
        outcome,
      );
    })
    .catch((e: unknown) => {
      const msg = typeof e === "string" ? e : (e as Error).message ?? "unknown";
      useChat.getState().updateToolCall(messageId, toolCallId, {
        status: "failed",
        error: msg,
      });
    });
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
