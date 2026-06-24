import { listen } from "@tauri-apps/api/event";
import { ArrowUp, KeyRound, X, PanelRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { TopBar } from "@/components/ui";
import {
  cloudConversationsGet,
  cloudConversationsPostMessage,
  cloudConversationsSubscribe,
  cloudConversationsUnsubscribe,
  cloudConversationsVerifyChain,
  EVT_CONVERSATION_EVENT,
  type ConversationDetail,
  type ConversationMessageRow,
  type VerifyChainResult,
} from "@/lib/cloud-ipc";
import { dispatchSlashCommand } from "@/lib/slash-dispatch";
import { parseSlashCommand } from "@/lib/slash";
import { useChat, type ChatMessage } from "@/lib/store/chat";
import {
  AlertDetailPanel,
  useAlertDetailPanel,
  useAlertDetailPanelKeyboard,
} from "@/components/alert-detail-panel";

interface MainConversationProps {
  conversationId: string;
  onClose: () => void;
  testId?: string;
}

/**
 * Inari Live V1 Session 5 — full conversation viewer.
 *
 * Hydrates from `/api/conversations/[id]` then opens a per-conversation
 * SSE subscription via the Rust IPC. Slash commands flow through the
 * existing dispatcher with `conversationId` set so the lifecycle
 * handlers (`/snooze`, `/resolve`, `/witness verify`) operate on the
 * correct thread.
 *
 * The right context strip is a stripped-down counterpart to the web's
 * ContextPanel — Mode A / B / C share the same shape but with desktop-
 * native chrome.
 */
export function MainConversation({ conversationId, onClose, testId }: MainConversationProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<ConversationMessageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyChainResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // AlertDetailPanel — `Cmd+\` sidecar bound to this conversation's
  // anchor alert. Installing the keyboard hook here means the toggle
  // only works while the conversation is on-screen (matching the
  // user expectation — the panel doesn't make sense outside a
  // conversation context).
  useAlertDetailPanelKeyboard();
  const panelOpen = useAlertDetailPanel((s) => s.isOpen);
  const setPanelAnchor = useAlertDetailPanel((s) => s.setAnchor);
  const closePanel = useAlertDetailPanel((s) => s.close);
  const togglePanel = useAlertDetailPanel((s) => s.toggle);

  const refresh = useCallback(async () => {
    try {
      const result = await cloudConversationsGet(conversationId);
      setDetail(result);
      setMessages(result.messages);
      // Sync the AlertDetailPanel's anchor to this conversation's
      // alert (may be null for free-chat threads — the panel handles
      // that gracefully with its no-anchor state).
      setPanelAnchor(result.conversation.anchorAlertId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [conversationId, setPanelAnchor]);

  // Clear the anchor when this conversation unmounts so the panel
  // doesn't keep rendering stale data for a closed conversation.
  useEffect(() => {
    return () => setPanelAnchor(null);
  }, [setPanelAnchor]);

  useEffect(() => {
    void refresh();
    void cloudConversationsSubscribe(conversationId).catch(() => {
      /* non-fatal — full refresh path still works */
    });
    return () => {
      void cloudConversationsUnsubscribe(conversationId).catch(() => {});
    };
  }, [conversationId, refresh]);

  // Auto-scroll on new messages.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 24;
  }, []);

  // Per-conversation SSE pushes via Rust → tauri event.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const off = await listen<{ event: string; data: string; conversationId: string | null }>(
          EVT_CONVERSATION_EVENT,
          (e) => {
            if (cancelled) return;
            if (e.payload.conversationId !== conversationId) return;
            if (e.payload.event === "message") {
              try {
                const payload = JSON.parse(e.payload.data) as {
                  message: {
                    id: string;
                    role: string;
                    content: unknown;
                    createdAt: string;
                    deviceId: string | null;
                    toolCallId: string | null;
                  };
                };
                const newRow: ConversationMessageRow = {
                  id:               payload.message.id,
                  conversationId,
                  role:             payload.message.role as ConversationMessageRow["role"],
                  contentJson:      payload.message.content,
                  toolCallId:       payload.message.toolCallId,
                  createdAt:        payload.message.createdAt,
                  deviceId:         payload.message.deviceId,
                  prevMessageHash:  null,
                  messageHash:      null,
                };
                setMessages((prev) => {
                  if (prev.some((m) => m.id === newRow.id)) return prev;
                  return [...prev, newRow];
                });
              } catch { /* ignore */ }
            } else if (e.payload.event === "state") {
              void refresh();
            }
          },
        );
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch { /* tauri runtime missing */ }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [conversationId, refresh]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;

    setBusy(true);
    setError(null);

    // Slash commands: route through the shared dispatcher with
    // conversationId set so the lifecycle handlers fire correctly.
    if (text.startsWith("/")) {
      const parsed = parseSlashCommand(text);
      if (parsed) {
        await dispatchSlashCommand(parsed, {
          appendMessage: (msg) => {
            // Synthesize a non-persisted note that displays inline.
            const note: ConversationMessageRow = {
              id:               `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              conversationId,
              role:             roleForLocalNote(msg),
              contentJson:      { text: msg.content, meta: { source: "slash-note" } },
              toolCallId:       null,
              createdAt:        new Date().toISOString(),
              deviceId:         null,
              prevMessageHash:  null,
              messageHash:      null,
            };
            setMessages((prev) => [...prev, note]);
          },
          sessionId: useChat.getState().sessionId,
          conversationId,
        });
        setDraft("");
        setBusy(false);
        stickRef.current = true;
        return;
      }
    }

    try {
      await cloudConversationsPostMessage(conversationId, text);
      setDraft("");
      stickRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async () => {
    setVerifying(true);
    try {
      const result = await cloudConversationsVerifyChain(conversationId);
      setVerify(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "verify failed");
    } finally {
      setVerifying(false);
    }
  };

  const conversation = detail?.conversation ?? null;
  const isResolved = conversation?.state === "resolved";
  const isSnoozed  = conversation?.state === "snoozed";

  const anchorAlertId = conversation?.anchorAlertId ?? null;

  return (
    <section
      data-testid={testId ?? "main-conversation"}
      className="h-full flex flex-col relative"
      style={{ background: "var(--bg)" }}
    >
      <TopBar
        testId="main-conversation-topbar"
        title={conversation?.title ?? "Conversation"}
        meta={isResolved ? "Resolved" : isSnoozed ? "Snoozed" : "Active"}
        actions={
          <>
            <VerifyChip
              state={verifying ? "verifying" : verify ? interpretVerify(verify) : "idle"}
              onClick={onVerify}
            />
            {anchorAlertId ? (
              <button
                type="button"
                aria-label={panelOpen ? "Close detail panel" : "Open detail panel"}
                title={panelOpen ? "Close detail panel (⌘\\)" : "Open detail panel (⌘\\)"}
                data-testid="main-conversation-toggle-panel"
                onClick={togglePanel}
                className={`rounded-md p-1.5 transition-colors ${panelOpen ? "bg-white/[0.04]" : ""}`}
                style={{ color: "var(--text-subtle)" }}
              >
                <PanelRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Close conversation"
              data-testid="main-conversation-close"
              onClick={onClose}
              className="rounded-md p-1.5 transition-colors"
              style={{ color: "var(--text-subtle)" }}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </>
        }
      />

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto">
        <div className="mx-auto max-w-[760px] px-6 py-6">
          {messages.length === 0 ? (
            <p className="text-center text-sm" style={{ color: "var(--text-muted)" }}>
              AI analysis pending — try posting a question to kick things off.
            </p>
          ) : (
            <ul className="flex flex-col gap-5">
              {messages.map((msg) => (
                <li key={msg.id}>
                  <MessageBubble message={msg} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="px-6 py-3"
        style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}
        aria-label="Composer"
      >
        <div className="mx-auto max-w-[760px] flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={isResolved ? "Reopen with /reopen, or type a message…" : "Reply or type / for commands…"}
            data-testid="main-conversation-input"
            className="flex-1 rounded-lg px-3 py-2 text-sm"
            style={{
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
            }}
          />
          <button
            type="submit"
            aria-label="Send"
            data-testid="main-conversation-send"
            disabled={busy || !draft.trim()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed"
            style={{
              background: draft.trim() && !busy ? "var(--accent)" : "var(--surface)",
              color: draft.trim() && !busy ? "white" : "var(--text-faint)",
            }}
          >
            <ArrowUp className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {error ? (
          <p className="mx-auto mt-2 max-w-[760px] text-xs" style={{ color: "var(--accent)" }}>
            {error}
          </p>
        ) : null}
      </form>

      {/* AlertDetailPanel — Cmd+\ sidecar. Renders over the chat as an
       *  absolutely-positioned overlay (does NOT push content). Only
       *  mounted when open so the IPC fetches don't fire while closed. */}
      {panelOpen ? (
        <AlertDetailPanel
          alertId={anchorAlertId}
          onClose={closePanel}
        />
      ) : null}
    </section>
  );
}

function MessageBubble({ message }: { message: ConversationMessageRow }) {
  const text =
    typeof message.contentJson === "object" && message.contentJson !== null
      ? ((message.contentJson as { text?: string }).text ?? "")
      : "";
  const isUser = message.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className="inline-flex max-w-[85%] flex-col rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
        style={
          isUser
            ? { background: "var(--accent)", color: "white" }
            : { background: "var(--surface)", color: "var(--text)" }
        }
      >
        {text || <span className="opacity-60 italic">(no content)</span>}
      </div>
    </div>
  );
}

interface VerifyChipProps {
  state: "idle" | "verifying" | "ok" | "tampered" | "unverifiable";
  onClick: () => void;
}

function VerifyChip({ state, onClick }: VerifyChipProps) {
  const label =
    state === "verifying"   ? "verifying…" :
    state === "ok"           ? "✓ verified" :
    state === "tampered"     ? "✗ tampered" :
    state === "unverifiable" ? "⚠ unverifiable" :
    "verify";
  const color =
    state === "ok"           ? "#10b981" :
    state === "tampered"     ? "var(--accent)" :
    state === "unverifiable" ? "#f59e0b" :
    "var(--text-muted)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "verifying"}
      data-testid="main-conversation-verify"
      title="Verify witness chain"
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium"
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        color,
      }}
    >
      <KeyRound className="h-3 w-3" aria-hidden />
      {label}
    </button>
  );
}

function interpretVerify(result: VerifyChainResult): "ok" | "tampered" | "unverifiable" {
  if (result.ok) return "ok";
  if (result.firstBreakAt?.reason === "missing_hash") return "unverifiable";
  return "tampered";
}

function roleForLocalNote(msg: ChatMessage): ConversationMessageRow["role"] {
  if (msg.role === "user") return "user";
  return "assistant";
}
