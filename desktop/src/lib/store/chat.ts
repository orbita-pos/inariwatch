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

import type { Alert, DiffPayload, Fix } from "@/types/alert";

/**
 * `alert` and `diff` are the Mode-3 / Mode-4 surfaces added in Sesión 16.
 * They share the same store so transitions (idle → conversation, idle →
 * alert → diff, alert ↔ diff) all live behind a single `mode` enum that
 * `DockShell.tsx` keys its `<AnimatePresence>` swap off.
 */
export type ChatMode = "idle" | "conversation" | "alert" | "diff";

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

  /**
   * Sesión 16 — alert triage slot. Set by `openAlert(alert)` when the
   * dock transitions into Mode 3 (e.g. from a CommandPalette action,
   * tray click, or `daemon:event` push). Cleared back to null on
   * `clearConversation` so the next idle entry starts fresh.
   */
  currentAlert: Alert | null;
  /**
   * Sesión 16 — diff viewer slot. Set by `openDiff(payload)`. The
   * Mode-4 screen resolves the full Fix payload from `currentFix` (or
   * fetches it via `get_fix_by_id` if `currentFix === null` and only
   * the lookup id is known).
   */
  currentFix: Fix | null;
  /**
   * Last known `DiffPayload` request — kept so the diff screen can
   * re-fetch on remount without losing the alert correlation.
   */
  pendingDiff: DiffPayload | null;
  /**
   * Sesión 19 — when Mode 4 was entered via the local-remediation
   * pipeline (NOT the legacy S16 alert-fix path), this carries the
   * orchestrator's session id so the apply / reject buttons route
   * through `applyRemediation` / `rejectRemediation` instead of the
   * S16 `applyFix` / `rejectFix` stubs.
   *
   * Cleared on `clearConversation` and on `backToAlert` (the back
   * button intentionally drops the active remediation session — the
   * user re-enters S19's "Fix with AI" flow if they want to retry).
   */
  remediationSessionId: string | null;

  setMode: (mode: ChatMode) => void;
  setInputValue: (value: string) => void;
  startConversation: () => void;
  sendMessage: (text: string) => void;
  clearConversation: () => void;
  replayLast: () => void;

  /** Open Mode 3 (alert triage) with the given alert payload. */
  openAlert: (alert: Alert) => void;
  /**
   * Open Mode 4 (diff viewer). Pass either a full `Fix` (test fixtures
   * + most production paths once the IPC lands) or just a `DiffPayload`
   * lookup; the screen handles the loading state itself.
   */
  openDiff: (input: Fix | DiffPayload) => void;
  /** Mode 4 → Mode 3 backwards transition (the "← back" button). */
  backToAlert: () => void;
  /**
   * Sesión 19 — open Mode 4 with a fresh remediation session draft.
   * Synthesizes a Fix payload from the draft so DockDiff's existing
   * render path stays unchanged. The orchestrator's session id is
   * stashed on `remediationSessionId` so apply / reject route to the
   * S19 IPC instead of the S16 stub.
   */
  openRemediationDraft: (input: {
    sessionId: string;
    repoId: string;
    diff: string;
    filesTouched: string[];
    errorMessage?: string;
  }) => void;

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

function isFix(input: Fix | DiffPayload): input is Fix {
  return (
    typeof (input as Fix).filePath === "string" &&
    typeof (input as Fix).diff === "string"
  );
}

/**
 * Best-effort Shiki language inference from file extension. The
 * synthesized Fix payload uses this so DockDiff's `<DiffViewer>` picks
 * a sensible highlighter even when the orchestrator's draft only
 * carries a path.
 */
function inferLanguageFromPath(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "text";
  const ext = path.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
  };
  return map[ext] ?? "text";
}

export const useChat = create<ChatStore>((set, get) => ({
  mode: "idle",
  messages: [],
  inputValue: "",
  sessionId: null,

  currentAlert: null,
  currentFix: null,
  pendingDiff: null,
  remediationSessionId: null,

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
      currentAlert: null,
      currentFix: null,
      pendingDiff: null,
      remediationSessionId: null,
    });
  },

  replayLast: () => {
    const { messages, sendMessage } = get();
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) sendMessage(lastUser.content);
  },

  openAlert: (alert) => {
    set({
      mode: "alert",
      currentAlert: alert,
      // Clear any stale diff state from a previous Mode-4 visit so the
      // back button on a re-entered Mode-3 doesn't bounce to a phantom
      // diff. Tests rely on this.
      currentFix: null,
      pendingDiff: null,
    });
  },

  openDiff: (input) => {
    if (isFix(input)) {
      set({
        mode: "diff",
        currentFix: input,
        pendingDiff: { alertId: input.alertId, fixId: input.id },
      });
    } else {
      set({
        mode: "diff",
        currentFix: null,
        pendingDiff: input,
      });
    }
  },

  backToAlert: () => {
    const { currentAlert } = get();
    if (currentAlert) {
      // Don't drop currentFix — going forward to Mode 4 again should be
      // free of a re-fetch. The diff stays cached until clearConversation.
      // Sesión 19: drop the remediation session marker so a fresh
      // "Fix with AI" click starts a new session instead of replaying.
      set({ mode: "alert", remediationSessionId: null });
    } else {
      // No alert in flight (edge case: user landed on Mode 4 directly
      // and hits back). Fall through to idle so the dock has somewhere
      // sensible to land.
      set({ mode: "idle", remediationSessionId: null });
    }
  },

  openRemediationDraft: ({ sessionId, repoId: _repoId, diff, filesTouched, errorMessage }) => {
    // Synthesize a Fix payload so DockDiff's existing render path
    // works unchanged. `gates` stays empty until Sesión 20 plumbs
    // gate results in; `replayMatch` / `eapSignature` are null for a
    // freshly-generated draft.
    const filePath = filesTouched[0] ?? "(unknown)";
    const fix: Fix = {
      id: sessionId,
      alertId: errorMessage ?? "",
      filePath,
      diff,
      language: inferLanguageFromPath(filePath),
      gates: [],
      replayMatch: null,
      eapSignature: null,
    };
    set({
      mode: "diff",
      currentFix: fix,
      pendingDiff: { alertId: fix.alertId, fixId: fix.id },
      remediationSessionId: sessionId,
      // Stay correlated with whichever alert (if any) opened this
      // session — let the user back to it via DockDiff's back arrow.
      // currentAlert is preserved on purpose; do NOT clear it.
    });
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
    currentAlert: null,
    currentFix: null,
    pendingDiff: null,
    remediationSessionId: null,
  });
  setStreamDriver(null);
}
