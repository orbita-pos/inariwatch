/**
 * Chat store for the Inari Live dock conversation surface.
 *
 * Source of truth for the dock's `mode`/`messages`/`inputValue`/`sessionId`.
 * Streaming tokens append directly via `appendToken` so the streamer (real
 * `daemon:event` ChatTokenStream listener or the mock fallback) doesn't need
 * to read state itself.
 *
 * Persistence: chat history lives in the daemon (Sesión 18 wires the
 * `persist_chat_message` IPC). On the frontend we keep the live thread in
 * memory only — `clearConversation` blanks it without touching the daemon
 * (the daemon's history survives so users can scroll back later from the
 * main window). The store does NOT use `zustand/middleware/persist`.
 */

import { create } from "zustand";

export type ChatMode = "idle" | "conversation";

export interface ToolCall {
  id: string;
  name: string;
  /** Free-form JSON input the assistant passed to the tool. */
  input?: unknown;
  /** Free-form JSON output. `null` while the tool is in flight. */
  output?: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Markdown body. Empty string while streaming hasn't produced its first token. */
  content: string;
  toolCalls?: ToolCall[];
  /** True while the assistant is still emitting tokens for this message. */
  streaming?: boolean;
  /** Wall-clock ms when the message entered the thread. Used for relative timestamps. */
  createdAt: number;
}

export interface ChatStore {
  mode: ChatMode;
  messages: ChatMessage[];
  inputValue: string;
  sessionId: string | null;

  setMode: (mode: ChatMode) => void;
  setInputValue: (value: string) => void;
  startConversation: () => void;
  sendMessage: (text: string) => void;
  clearConversation: () => void;
  replayLast: () => void;

  // ── streaming hooks (called by the streaming pipeline) ─────────────
  /** Append the next token to the assistant message with the given id. */
  appendToken: (messageId: string, token: string) => void;
  /** Mark the assistant message as fully streamed. */
  finishStreaming: (messageId: string) => void;
}

let messageIdCounter = 0;
function newMessageId(): string {
  messageIdCounter += 1;
  return `msg_${Date.now()}_${messageIdCounter}`;
}

let sessionIdCounter = 0;
function newSessionId(): string {
  sessionIdCounter += 1;
  // Crypto-strong randomness isn't required: the daemon assigns the
  // canonical session_id when it accepts the message (Sesión 9 posture
  // — never trust a client-issued id). This is a UI-only correlation key.
  return `local_${Date.now()}_${sessionIdCounter}`;
}

/**
 * Streaming-driver hook. Subclassed by the real `daemon:event` listener
 * and the mock fallback (Sesión 15 ships the mock; Sesión 18 wires the
 * real one). Returning a function lets us swap implementations under
 * test without monkey-patching the store.
 */
let streamDriver: ((messageId: string, prompt: string) => void) | null = null;

export function setStreamDriver(
  driver: ((messageId: string, prompt: string) => void) | null,
): void {
  streamDriver = driver;
}

export const useChat = create<ChatStore>((set, get) => ({
  mode: "idle",
  messages: [],
  inputValue: "",
  sessionId: null,

  setMode: (mode) => set({ mode }),
  setInputValue: (value) => set({ inputValue: value }),

  startConversation: () => {
    const { sessionId } = get();
    set({
      mode: "conversation",
      sessionId: sessionId ?? newSessionId(),
    });
  },

  sendMessage: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { sessionId } = get();
    const sid = sessionId ?? newSessionId();

    const userMsg: ChatMessage = {
      id: newMessageId(),
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: newMessageId(),
      role: "assistant",
      content: "",
      streaming: true,
      createdAt: Date.now(),
    };

    set((s) => ({
      mode: "conversation",
      sessionId: sid,
      inputValue: "",
      messages: [...s.messages, userMsg, assistantMsg],
    }));

    if (streamDriver) {
      streamDriver(assistantMsg.id, trimmed);
    } else {
      // No driver wired — finalize immediately so tests + headless renders
      // don't see a permanent "streaming" spinner.
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantMsg.id ? { ...m, streaming: false } : m,
        ),
      }));
    }
  },

  clearConversation: () => {
    set({
      mode: "idle",
      messages: [],
      sessionId: null,
      inputValue: "",
    });
  },

  replayLast: () => {
    const { messages, sendMessage } = get();
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) sendMessage(lastUser.content);
  },

  appendToken: (messageId, token) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, content: m.content + token } : m,
      ),
    }));
  },

  finishStreaming: (messageId) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, streaming: false } : m,
      ),
    }));
  },
}));

/**
 * Test-only helper. Resets the store between tests so each `it` block
 * starts from a clean idle state.
 */
export function __resetChatStoreForTests(): void {
  useChat.setState({
    mode: "idle",
    messages: [],
    inputValue: "",
    sessionId: null,
  });
  setStreamDriver(null);
}
