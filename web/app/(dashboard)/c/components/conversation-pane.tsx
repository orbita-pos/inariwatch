"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { cn, formatRelativeTime } from "@/lib/utils";
import { dispatchConversationSlash } from "@/lib/conversations/web-slash-dispatch";
import type { ConversationDetailMessage } from "./types";

interface ConversationPaneProps {
  conversationId: string;
  title: string;
  state: "active" | "snoozed" | "resolved" | "archived";
  initialMessages: ConversationDetailMessage[];
}

/**
 * Conversation surface — chat thread + composer.
 *
 * Visual contract: matches `desktop/src/screens/DockConversation.tsx`
 * geometry (max-w 760px reading column, message bubbles, input pinned
 * at the bottom). The web version doesn't run voice (no Whisper) and
 * doesn't show inline tool cards yet (S6 follow-up); both are scope OUT
 * per the S5 brief.
 *
 * SSE merge: opens `/api/conversations/[id]/event-stream` and:
 *   * `message` → append (or replace if matching id already exists).
 *   * `state`   → patches the local state (drives header chip).
 *
 * Slash commands (snooze / resolve / ack / silence / escalate /
 * summarize / export / witness verify / witness export) flow through
 * `dispatchConversationSlash`. The composer dispatches when input
 * starts with `/`; otherwise it POSTs to /messages.
 */
export function ConversationPane({
  conversationId,
  title,
  state,
  initialMessages,
}: ConversationPaneProps) {
  const [messages, setMessages] = useState<ConversationDetailMessage[]>(initialMessages);
  const [currentState, setCurrentState] = useState(state);
  const [draft, setDraft]    = useState("");
  const [busy, setBusy]      = useState(false);
  const [error, setError]    = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef  = useRef<boolean>(true);

  // Auto-scroll to bottom on new messages while user is parked there.
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

  // SSE merge.
  useEffect(() => {
    const es = new EventSource(`/api/conversations/${conversationId}/event-stream`, {
      withCredentials: true,
    });
    const onMessage = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as {
          message: {
            id: string;
            role: ConversationDetailMessage["role"];
            content: { text?: string; meta?: Record<string, unknown> } | unknown;
            createdAt: string;
            deviceId: string | null;
            toolCallId: string | null;
          };
        };
        const msg: ConversationDetailMessage = {
          id:               payload.message.id,
          conversationId,
          role:             payload.message.role,
          contentJson:      (payload.message.content as ConversationDetailMessage["contentJson"]) ?? {},
          toolCallId:       payload.message.toolCallId,
          createdAt:        payload.message.createdAt,
          deviceId:         payload.message.deviceId,
          prevMessageHash:  null,
          messageHash:      null,
        };
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      } catch {
        /* ignore malformed */
      }
    };
    const onState = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as { state: string };
        setCurrentState(payload.state as typeof currentState);
      } catch {
        /* ignore */
      }
    };
    es.addEventListener("message", onMessage);
    es.addEventListener("state", onState);
    return () => {
      es.removeEventListener("message", onMessage);
      es.removeEventListener("state", onState);
      es.close();
    };
  }, [conversationId]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);

    if (text.startsWith("/")) {
      const result = await dispatchConversationSlash(conversationId, text);
      if (result.handled) {
        setDraft("");
        if (result.note) {
          // Synthesize an inline assistant note (client-side only — not persisted).
          // Slash commands that change server state already broadcast through SSE.
          setMessages((prev) => [
            ...prev,
            {
              id:               `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              conversationId,
              role:             "assistant",
              contentJson:      { text: result.note ?? "", meta: { source: "slash-note" } },
              toolCallId:       null,
              createdAt:        new Date().toISOString(),
              deviceId:         null,
              prevMessageHash:  null,
              messageHash:      null,
            },
          ]);
        }
        if (result.error) setError(result.error);
        setBusy(false);
        stickRef.current = true;
        return;
      }
    }

    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ content: text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `HTTP ${res.status}`);
      }
      // The SSE stream will deliver the persisted row; we don't append
      // optimistically to avoid a flash of duplicate-then-replace.
      setDraft("");
      stickRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setBusy(false);
    }
  };

  const isResolved = currentState === "resolved";
  const isSnoozed  = currentState === "snoozed";

  return (
    <div data-testid="conversation-pane" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line px-6 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-fg-strong">{title}</h1>
          <p className="text-[11px] text-fg-base/60">
            {isResolved ? "Resolved" : isSnoozed ? "Snoozed" : "Active"}
          </p>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto"
      >
        <div className="mx-auto max-w-[760px] px-6 py-6">
          {messages.length === 0 ? (
            <EmptyAnalyzePending conversationId={conversationId} />
          ) : (
            <ul className="flex flex-col gap-5">
              {messages.map((msg) => (
                <li key={msg.id}>
                  <MessageRow message={msg} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t border-line bg-surface px-6 py-3"
        aria-label="Message composer"
      >
        <div className="mx-auto max-w-[760px] flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={isResolved ? "Reopen with /reopen, or type a message…" : "Reply or type / for commands…"}
            data-testid="conversation-composer-input"
            className="flex-1 rounded-lg border border-line bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent focus:outline-none focus:ring-1 focus:ring-inari-accent"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={busy || !draft.trim()}
            data-testid="conversation-composer-send"
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
              draft.trim() && !busy
                ? "bg-inari-accent text-white hover:bg-inari-accent/90"
                : "bg-surface-dim text-fg-base/40 cursor-not-allowed",
            )}
          >
            <ArrowUp aria-hidden className="h-4 w-4" />
          </button>
        </div>
        {error ? (
          <p className="mx-auto mt-2 max-w-[760px] text-xs text-inari-accent">{error}</p>
        ) : null}
      </form>
    </div>
  );
}

function MessageRow({ message }: { message: ConversationDetailMessage }) {
  const text = (message.contentJson?.text ?? "").trim();
  const isAssistant = message.role === "assistant";
  const isTool      = message.role === "tool";
  const isSystem    = message.role === "system";

  if (isSystem) {
    return (
      <div className="text-center text-[11px] uppercase tracking-[0.18em] text-fg-base/50">
        {text}
      </div>
    );
  }

  return (
    <div
      data-testid={`conversation-message-${message.role}`}
      className={cn("flex flex-col gap-1", message.role === "user" ? "items-end" : "items-start")}
    >
      <div
        className={cn(
          "inline-flex max-w-[85%] flex-col rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
          isAssistant
            ? "bg-surface-dim text-fg-base"
            : isTool
              ? "border border-line-medium bg-surface text-fg-base font-mono text-xs"
              : "bg-inari-accent text-white",
        )}
      >
        {text || <span className="opacity-60 italic">(no content)</span>}
      </div>
      <span className="text-[10px] text-fg-base/40 font-mono">
        {formatRelativeTime(new Date(message.createdAt))}
      </span>
    </div>
  );
}

function EmptyAnalyzePending({ conversationId }: { conversationId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hint the underlying hook (auto-analyze) by calling the existing
  // /api/chat fallback as a manual triage. For V1 we just nudge the
  // user with a "Try again" pattern — the actual auto-analyze runs
  // server-side post-alert-create. If a thread arrives empty (analyze
  // failed), this surface tries the chat endpoint as the fallback.
  const tryAgain = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          content: "Please analyze the alert that anchors this conversation.",
          meta:    { source: "retry-analyze" },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Try again failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-12 text-center">
      <p className="text-sm font-medium text-fg-base">AI analysis pending</p>
      <p className="text-xs text-fg-base/60">
        Auto-analyze hasn&apos;t posted yet — it usually runs within a few seconds of an alert arriving.
      </p>
      <button
        type="button"
        onClick={tryAgain}
        disabled={busy}
        className="mt-2 rounded-lg border border-line bg-surface-dim px-3 py-1.5 text-xs font-medium text-fg-base hover:text-fg-strong hover:border-line-medium transition-colors disabled:opacity-50"
      >
        {busy ? "Trying…" : "Try again"}
      </button>
      {error ? <p className="text-xs text-inari-accent">{error}</p> : null}
    </div>
  );
}
