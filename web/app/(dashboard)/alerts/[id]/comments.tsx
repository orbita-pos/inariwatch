"use client";

import { useState, useTransition } from "react";
import { Trash2, Loader2, Send, X } from "lucide-react";
import { addComment, deleteComment } from "./comment-actions";
import { formatRelativeTime } from "@/lib/utils";

interface Comment {
  id:        string;
  body:      string;
  userName:  string | null;
  userEmail: string;
  createdAt: Date;
  userId:    string;
}

interface CommentsSectionProps {
  alertId:       string;
  comments:      Comment[];
  currentUserId: string;
}

function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-violet-600",
  "bg-blue-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-cyan-600",
  "bg-fuchsia-600",
  "bg-teal-600",
];

function getAvatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const MAX_COMMENT_LENGTH = 2000;

export function CommentsSection({ alertId, comments, currentUserId }: CommentsSectionProps) {
  const [body, setBody]      = useState("");
  const [error, setError]    = useState<string | null>(null);
  const [isAdding, startAdd] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setError(null);

    startAdd(async () => {
      const result = await addComment(alertId, body);
      if (result.error) {
        setError(result.error);
      } else {
        setBody("");
      }
    });
  };

  return (
    <section
      aria-labelledby="comments-heading"
      className="rounded-xl border border-line bg-surface overflow-hidden"
    >
      <div className="border-b border-line px-5 py-3">
        <h2 id="comments-heading" className="text-xs font-medium uppercase tracking-wider text-fg-base/70">
          Comments{comments.length > 0 ? ` (${comments.length})` : ""}
        </h2>
      </div>

      <div className="px-5 py-4 space-y-4">
        {comments.length === 0 ? (
          <p className="text-sm text-fg-base/70 text-center py-2">
            No comments yet. Start the discussion.
          </p>
        ) : (
          <ul className="space-y-3">
            {comments.map((comment) => (
              <li key={comment.id}>
                <CommentCard
                  comment={comment}
                  isOwn={comment.userId === currentUserId}
                />
              </li>
            ))}
          </ul>
        )}

        {/* Add comment form */}
        <form onSubmit={handleSubmit} className="space-y-2">
          <label htmlFor="new-comment" className="sr-only">
            Add a comment
          </label>
          <textarea
            id="new-comment"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a comment…"
            rows={3}
            maxLength={MAX_COMMENT_LENGTH}
            disabled={isAdding}
            aria-describedby="comment-hint"
            aria-invalid={error !== null}
            className="w-full rounded-lg border border-line bg-surface-inner px-3.5 py-2.5 text-sm text-fg-strong placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 resize-none disabled:opacity-50 transition-colors"
          />
          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between">
            <span
              id="comment-hint"
              className="text-xs text-fg-base/60"
              aria-live={body.length > MAX_COMMENT_LENGTH - 100 ? "polite" : "off"}
            >
              {body.length > 0
                ? `${body.length}/${MAX_COMMENT_LENGTH}`
                : `Max ${MAX_COMMENT_LENGTH} characters`}
            </span>
            <button
              type="submit"
              disabled={isAdding || !body.trim()}
              aria-busy={isAdding}
              className="inline-flex items-center gap-1.5 rounded-lg border border-inari-accent/30 bg-inari-accent/10 px-3.5 py-1.5 text-sm font-medium text-inari-accent hover:bg-inari-accent/20 hover:border-inari-accent/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              {isAdding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Comment
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function CommentCard({ comment, isOwn }: { comment: Comment; isOwn: boolean }) {
  const [isDeleting, startDelete] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const handleDelete = () => {
    setError(null);
    startDelete(async () => {
      const result = await deleteComment(comment.id);
      if (result.error) {
        setError(result.error);
        setConfirming(false);
      }
    });
  };

  const initials    = getInitials(comment.userName, comment.userEmail);
  const avatarColor = getAvatarColor(comment.userId);
  const displayName = comment.userName ?? comment.userEmail;

  return (
    <article
      aria-label={`Comment by ${displayName}`}
      className={`rounded-lg border border-line bg-surface-inner px-4 py-3 ${isDeleting ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white ${avatarColor}`}
          aria-hidden="true"
        >
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg-strong">{displayName}</span>
            <span className="text-xs text-fg-base/60">
              {formatRelativeTime(comment.createdAt)}
            </span>

            {isOwn && !confirming && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={isDeleting}
                aria-label={`Delete your comment`}
                title="Delete comment"
                className="ml-auto text-fg-base/50 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 rounded p-0.5"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            )}

            {isOwn && confirming && (
              <div
                role="alertdialog"
                aria-label="Confirm delete comment"
                className="ml-auto flex items-center gap-1"
              >
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 dark:bg-red-500 dark:hover:bg-red-600 transition-colors"
                >
                  {isDeleting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={isDeleting}
                  aria-label="Cancel delete"
                  className="flex h-5 w-5 items-center justify-center rounded text-fg-base/70 hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>

          {/* Body */}
          <p className="mt-1 text-sm text-fg-base leading-relaxed whitespace-pre-wrap break-words">
            {comment.body}
          </p>

          {error && (
            <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
