"use client";

import { useState, useTransition } from "react";
import { Trash2, Loader2, Send } from "lucide-react";
import { addComment, deleteComment } from "./comment-actions";
import { formatRelativeTime } from "@/lib/utils";

interface Comment {
  id: string;
  body: string;
  userName: string | null;
  userEmail: string;
  createdAt: Date;
  userId: string;
}

interface CommentsSectionProps {
  alertId: string;
  comments: Comment[];
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

export function CommentsSection({ alertId, comments, currentUserId }: CommentsSectionProps) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    <section className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
      <div className="border-b border-[#1a1a1a] px-5 py-3">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Comments{comments.length > 0 ? ` (${comments.length})` : ""}
        </span>
      </div>

      <div className="px-5 py-4 space-y-4">
        {comments.length === 0 ? (
          <p className="text-sm text-zinc-600 text-center py-2">
            No comments yet. Start the discussion.
          </p>
        ) : (
          <div className="space-y-3">
            {comments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                isOwn={comment.userId === currentUserId}
              />
            ))}
          </div>
        )}

        {/* Add comment form */}
        <form onSubmit={handleSubmit} className="space-y-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a comment..."
            rows={3}
            maxLength={2000}
            disabled={isAdding}
            className="w-full rounded-lg border border-[#1a1a1a] bg-[#080808] px-3.5 py-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 resize-none disabled:opacity-50 transition-colors"
          />
          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-700">
              {body.length > 0 ? `${body.length}/2000` : ""}
            </span>
            <button
              type="submit"
              disabled={isAdding || !body.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-inari-accent/30 bg-inari-accent/10 px-3.5 py-1.5 text-sm font-medium text-inari-accent hover:bg-inari-accent/20 hover:border-inari-accent/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isAdding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
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
  const [error, setError] = useState<string | null>(null);

  const handleDelete = () => {
    if (!confirm("Delete this comment?")) return;
    setError(null);
    startDelete(async () => {
      const result = await deleteComment(comment.id);
      if (result.error) setError(result.error);
    });
  };

  const initials = getInitials(comment.userName, comment.userEmail);
  const avatarColor = getAvatarColor(comment.userId);

  return (
    <div className={`rounded-lg border border-[#1a1a1a] bg-[#080808] px-4 py-3 ${isDeleting ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white ${avatarColor}`}>
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-300">
              {comment.userName ?? comment.userEmail}
            </span>
            <span className="text-xs text-zinc-700">
              {formatRelativeTime(comment.createdAt)}
            </span>
            {isOwn && (
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="ml-auto text-zinc-800 hover:text-red-400 transition-colors disabled:opacity-50"
                title="Delete comment"
              >
                {isDeleting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </button>
            )}
          </div>

          {/* Body */}
          <p className="mt-1 text-sm text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">
            {comment.body}
          </p>

          {error && (
            <p className="mt-1 text-xs text-red-400">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
