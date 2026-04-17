"use client";

/**
 * Comments side-panel body. Reads + writes via /api/replay/[sid]/comments.
 *
 * Polls every 30s while the panel is the active tab — comments are
 * inherently async, no need for SSE / live presence in v1. The poller
 * also short-circuits on tab visibility change so a backgrounded tab
 * doesn't keep hitting the server.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, MessageSquare, Send, Trash2 } from "lucide-react";
import { formatMs } from "../format-time";

export interface CommentRow {
  id: string;
  timestampMs: number;
  body: string;
  parentId: string | null;
  resolved: boolean;
  mentionedUserIds: string[];
  createdAt: string;
  authorId: string;
  authorName: string | null;
  authorEmail: string | null;
}

interface CommentsPanelProps {
  sessionId: string;
  currentMs: number;
  onSeek: (ms: number) => void;
  /** Current viewer — used to gate the Delete button on own comments. */
  currentUserId: string | null;
  /** Lifted state from the player so the timeline-canvas markers and the
   *  panel render the same dataset (one fetch, two consumers). */
  comments: CommentRow[];
  onCommentsChange: (next: CommentRow[]) => void;
}

export function countCommentsUnresolved(comments: CommentRow[]): number {
  let n = 0;
  for (const c of comments) if (!c.resolved) n++;
  return n;
}

export function CommentsPanel({
  sessionId,
  currentMs,
  onSeek,
  currentUserId,
  comments,
  onCommentsChange,
}: CommentsPanelProps) {
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [replyParent, setReplyParent] = useState<string | null>(null);

  // Poll every 30s while the panel is mounted + tab is visible.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = async () => {
      try {
        const r = await fetch(`/api/replay/${encodeURIComponent(sessionId)}/comments`);
        if (!r.ok) return;
        const data = (await r.json()) as { comments: CommentRow[] };
        onCommentsChange(data.comments ?? []);
      } catch {
        // network blip — ignore, next tick will retry
      }
    };
    const start = () => {
      if (timer) return;
      timer = setInterval(refresh, 30_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionId, onCommentsChange]);

  const handleSubmit = useCallback(async () => {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      const r = await fetch(`/api/replay/${encodeURIComponent(sessionId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: text,
          timestampMs: replyParent ? undefined : Math.round(currentMs),
          parentId: replyParent ?? undefined,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.warn("[comments] create failed:", err);
        return;
      }
      // Refetch the full list — simpler than client-side merge with sort.
      const list = await fetch(`/api/replay/${encodeURIComponent(sessionId)}/comments`);
      if (list.ok) {
        const data = (await list.json()) as { comments: CommentRow[] };
        onCommentsChange(data.comments ?? []);
      }
      setDraft("");
      setReplyParent(null);
    } finally {
      setPosting(false);
    }
  }, [draft, posting, sessionId, currentMs, replyParent, onCommentsChange]);

  const toggleResolved = useCallback(async (id: string, next: boolean) => {
    // Optimistic update — feels instant, server reconciles next poll
    onCommentsChange(comments.map((c) => (c.id === id ? { ...c, resolved: next } : c)));
    try {
      await fetch(`/api/replay/comments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved: next }),
      });
    } catch {
      // Poll loop will pick up the rollback
    }
  }, [comments, onCommentsChange]);

  const deleteComment = useCallback(async (id: string) => {
    if (!confirm("Delete this comment?")) return;
    try {
      await fetch(`/api/replay/comments/${id}`, { method: "DELETE" });
      onCommentsChange(
        comments.map((c) => (c.id === id ? { ...c, body: "[deleted]" } : c)),
      );
    } catch {
      // ignore — next poll reconciles
    }
  }, [comments, onCommentsChange]);

  // Group by top-level → replies. Top-levels stay sorted by timestamp.
  const threads = useMemo(() => {
    const byParent = new Map<string, CommentRow[]>();
    const tops: CommentRow[] = [];
    for (const c of comments) {
      if (c.parentId) {
        const list = byParent.get(c.parentId);
        if (list) list.push(c); else byParent.set(c.parentId, [c]);
      } else {
        tops.push(c);
      }
    }
    return tops
      .filter((t) => showResolved || !t.resolved)
      .map((t) => ({ top: t, replies: byParent.get(t.id) ?? [] }));
  }, [comments, showResolved]);

  const composerRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex h-full flex-col">
      {/* Sticky filter row */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-1 border-b border-line bg-surface px-3 py-1.5 text-[10px]">
        <span className="text-fg-base/50 uppercase tracking-wider">
          {threads.length} {threads.length === 1 ? "thread" : "threads"}
        </span>
        <button
          type="button"
          onClick={() => setShowResolved((v) => !v)}
          className={`rounded px-1.5 py-0.5 font-medium uppercase tracking-wider ${
            showResolved
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "text-fg-base/60 hover:text-fg-base"
          }`}
        >
          {showResolved ? "Hide resolved" : "Show resolved"}
        </button>
      </div>

      {threads.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-12 text-center text-fg-base/40">
          <MessageSquare className="h-5 w-5" aria-hidden="true" />
          <p className="text-xs">No comments yet. Drop a note to your team —</p>
          <p className="text-[10px]">use <code className="text-fg-base/60">@email</code> to ping a teammate.</p>
        </div>
      ) : (
        <ul className="flex-1 divide-y divide-line overflow-y-auto">
          {threads.map(({ top, replies }) => (
            <li key={top.id} className={top.resolved ? "opacity-60" : ""}>
              <Thread
                top={top}
                replies={replies}
                currentMs={currentMs}
                currentUserId={currentUserId}
                onSeek={onSeek}
                onResolve={toggleResolved}
                onDelete={deleteComment}
                onReply={() => {
                  setReplyParent(top.id);
                  composerRef.current?.focus();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Composer pinned to the bottom */}
      <div className="border-t border-line bg-surface/60 p-2">
        {replyParent && (
          <div className="mb-1 flex items-center gap-1 text-[10px] text-fg-base/60">
            <span>Replying to thread</span>
            <button
              type="button"
              onClick={() => setReplyParent(null)}
              className="text-fg-base/40 hover:text-fg-base"
            >
              cancel
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            rows={2}
            placeholder={replyParent
              ? "Reply… (Cmd/Ctrl+Enter)"
              : `Comment at ${formatMs(currentMs)}… use @email to ping`}
            className="min-w-0 flex-1 resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg-base placeholder:text-fg-base/40 focus:outline-none focus:border-inari-accent"
          />
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={posting || draft.trim().length === 0}
            className="inline-flex items-center gap-1 rounded-md bg-inari-accent px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Post comment"
          >
            <Send className="h-3 w-3" aria-hidden="true" />
            Post
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Thread / Comment row ───────────────────────────────────────────────

function Thread({
  top,
  replies,
  currentMs,
  currentUserId,
  onSeek,
  onResolve,
  onDelete,
  onReply,
}: {
  top: CommentRow;
  replies: CommentRow[];
  currentMs: number;
  currentUserId: string | null;
  onSeek: (ms: number) => void;
  onResolve: (id: string, next: boolean) => void;
  onDelete: (id: string) => void;
  onReply: () => void;
}) {
  return (
    <div
      className={`px-3 py-2 ${
        Math.abs(top.timestampMs - currentMs) < 250 ? "bg-inari-accent/[0.04]" : ""
      }`}
    >
      <CommentRowView
        c={top}
        onSeek={onSeek}
        onResolve={onResolve}
        onDelete={onDelete}
        onReply={onReply}
        currentUserId={currentUserId}
        showResolveButton
        showReplyButton
      />
      {replies.length > 0 && (
        <ul className="mt-2 ml-4 space-y-2 border-l border-line pl-2">
          {replies.map((r) => (
            <li key={r.id}>
              <CommentRowView
                c={r}
                onSeek={onSeek}
                onResolve={onResolve}
                onDelete={onDelete}
                onReply={onReply}
                currentUserId={currentUserId}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentRowView({
  c,
  onSeek,
  onResolve,
  onDelete,
  onReply,
  currentUserId,
  showResolveButton,
  showReplyButton,
}: {
  c: CommentRow;
  onSeek: (ms: number) => void;
  onResolve: (id: string, next: boolean) => void;
  onDelete: (id: string) => void;
  onReply: () => void;
  currentUserId: string | null;
  showResolveButton?: boolean;
  showReplyButton?: boolean;
}) {
  const author = c.authorName || c.authorEmail || "Someone";
  const isOwn = currentUserId !== null && currentUserId === c.authorId;
  const isDeleted = c.body === "[deleted]";

  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-2 text-fg-base/60">
        <button
          type="button"
          onClick={() => onSeek(c.timestampMs)}
          className="font-mono tabular-nums hover:text-inari-accent"
          title="Seek to this moment"
        >
          {formatMs(c.timestampMs)}
        </button>
        <span className="font-medium text-fg-base">{author}</span>
        <span className="text-fg-base/40">{relativeTime(c.createdAt)}</span>
        {showResolveButton && (
          <button
            type="button"
            onClick={() => onResolve(c.id, !c.resolved)}
            className={`ml-auto inline-flex items-center gap-1 rounded px-1 ${
              c.resolved
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-fg-base/40 hover:text-emerald-600"
            }`}
            title={c.resolved ? "Reopen" : "Resolve"}
            aria-label={c.resolved ? "Reopen comment" : "Resolve comment"}
          >
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            {c.resolved && <span className="text-[9px] uppercase">Done</span>}
          </button>
        )}
      </div>
      <p className={`mt-1 whitespace-pre-wrap break-words ${isDeleted ? "italic text-fg-base/40" : "text-fg-base"}`}>
        {renderBody(c.body)}
      </p>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-base/40">
        {showReplyButton && !isDeleted && (
          <button type="button" onClick={onReply} className="hover:text-fg-base">
            Reply
          </button>
        )}
        {isOwn && !isDeleted && (
          <button
            type="button"
            onClick={() => onDelete(c.id)}
            className="inline-flex items-center gap-0.5 hover:text-red-500"
            aria-label="Delete comment"
          >
            <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Lightweight body renderer — auto-link URLs + highlight @mentions. */
function renderBody(body: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(@[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\bhttps?:\/\/\S+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(body)) !== null) {
    if (match.index > last) parts.push(body.slice(last, match.index));
    const tok = match[0];
    if (tok.startsWith("@")) {
      parts.push(<span key={key++} className="rounded-sm bg-inari-accent/15 px-0.5 text-inari-accent">{tok}</span>);
    } else {
      parts.push(
        <a key={key++} href={tok} target="_blank" rel="noopener noreferrer" className="text-inari-accent underline underline-offset-2">
          {tok}
        </a>,
      );
    }
    last = match.index + tok.length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts;
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
