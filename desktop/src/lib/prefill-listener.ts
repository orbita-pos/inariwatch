/**
 * S7 — Listener for the `chat:prefill` Tauri event.
 *
 * Emitted from the backend when an ambient surface (tray Quick
 * Actions submenu, OS notification action callback, future right-
 * click on an alert row) wants the chat input pre-stuffed with a
 * prompt. The handler:
 *
 * 1. Sets `useChat.inputValue` to the payload's `text`.
 * 2. Flips `useChat.mode` to `"conversation"` so the dock animates
 *    out of idle and the input becomes visible.
 * 3. Stashes the payload's `alert_id` on `lastPrefilledAlertId` so
 *    the chat-stream driver can attach it as turn context when the
 *    user submits.
 *
 * Mirror of `installChatStreamDriver` — same lifecycle, same dynamic
 * import to keep test mocks lean. Returns a tear-down function.
 */

import { useChat } from "@/lib/store/chat";

/** Wire-shape of the `chat:prefill` event payload. */
export interface PrefillPayload {
  alert_id: string;
  text: string;
}

let lastPrefilledAlertId: string | null = null;

/**
 * Most recent `alert_id` the prefill event delivered. The chat-
 * stream driver / chat surface reads this to (eventually) attach the
 * id as turn context. Cleared once a message is sent so a stale
 * alert_id can't bleed into a fresh prompt.
 */
export function consumeLastPrefilledAlertId(): string | null {
  const id = lastPrefilledAlertId;
  lastPrefilledAlertId = null;
  return id;
}

/**
 * Subscribe to `chat:prefill`. Returns an unlisten fn — the dock
 * shell stashes it and calls it on unmount. Catches a missing Tauri
 * runtime (jsdom, no `@tauri-apps/api/event`) silently — the surface
 * just doesn't work in those environments, same posture as
 * `installChatStreamDriver`.
 */
export async function installPrefillListener(): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<PrefillPayload>("chat:prefill", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload.text !== "string") return;
      lastPrefilledAlertId = typeof payload.alert_id === "string" ? payload.alert_id : null;
      const store = useChat.getState();
      store.setInputValue(payload.text);
      // `startConversation` is idempotent — it only re-uses the
      // existing session id when one is set, so we don't churn an
      // active chat.
      store.startConversation();
    });
    return unlisten;
  } catch (e) {
    console.info("[prefill-listener] Tauri event API unavailable", e);
    return () => {};
  }
}

/** Test-only — drive the listener path synchronously. */
export function applyPrefillForTests(payload: PrefillPayload): void {
  if (!payload || typeof payload.text !== "string") return;
  lastPrefilledAlertId = typeof payload.alert_id === "string" ? payload.alert_id : null;
  const store = useChat.getState();
  store.setInputValue(payload.text);
  store.startConversation();
}

/** Test-only reset. */
export function __resetPrefillStateForTests(): void {
  lastPrefilledAlertId = null;
}
