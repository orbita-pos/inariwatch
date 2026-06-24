"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Eye, EyeOff, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { createPost, updatePost } from "./actions";

const TAGS = ["Engineering", "Feature", "Update", "DevOps", "Open Source"];

export function PostEditor({
  existing,
}: {
  existing?: {
    id: string;
    title: string;
    description: string;
    content: string;
    tag: string;
    isPublished: boolean;
  };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    title: existing?.title ?? "",
    description: existing?.description ?? "",
    content: existing?.content ?? "",
    tag: existing?.tag ?? "Update",
  });

  function set(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function handleSave(publish: boolean) {
    setError(null);
    startTransition(async () => {
      const result = existing
        ? await updatePost(existing.id, { ...form, publish })
        : await createPost({ ...form, publish });

      if ("error" in result && result.error) {
        setError(result.error);
        return;
      }
      router.push("/admin/blog");
      router.refresh();
    });
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-6 py-3">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/blog"
            className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            All posts
          </Link>
          <span className="text-zinc-700">/</span>
          <span className="text-sm text-zinc-400">
            {existing ? "Edit post" : "New post"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPreview(!preview)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {preview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {preview ? "Edit" : "Preview"}
          </button>
          <button
            onClick={() => handleSave(false)}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition-colors"
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save draft
          </button>
          <button
            onClick={() => handleSave(true)}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {existing?.isPublished ? "Save & publish" : "Publish"}
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-10 space-y-6">
        {error && (
          <div className="rounded-lg border border-red-900/30 bg-red-950/20 px-4 py-3">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Meta fields */}
        <div className="space-y-4">
          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1.5 block">Title</label>
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="You sleep. We ship."
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-xl font-bold text-white placeholder-zinc-700 focus:border-violet-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-4">
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1.5 block">Description</label>
              <input
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="One-line summary shown in the blog index"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-white placeholder-zinc-700 focus:border-violet-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1.5 block">Tag</label>
              <select
                value={form.tag}
                onChange={(e) => set("tag", e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-white focus:border-violet-500 focus:outline-none"
              >
                {TAGS.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="border-t border-zinc-800" />

        {/* Editor / Preview */}
        {preview ? (
          <div
            className="prose prose-invert prose-zinc max-w-none
              prose-headings:font-bold prose-headings:text-white prose-headings:tracking-tight
              prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4
              prose-p:text-zinc-300 prose-p:leading-relaxed
              prose-a:text-violet-400 prose-a:no-underline hover:prose-a:underline
              prose-strong:text-white
              prose-code:text-violet-300 prose-code:bg-zinc-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:before:content-none prose-code:after:content-none
              prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800 prose-pre:rounded-xl
              prose-blockquote:border-violet-500 prose-blockquote:text-zinc-400
              prose-ul:text-zinc-300 prose-li:my-1
              prose-hr:border-zinc-800"
            dangerouslySetInnerHTML={{ __html: simpleMarkdown(form.content) }}
          />
        ) : (
          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider mb-1.5 block">
              Content <span className="normal-case text-zinc-700">(Markdown)</span>
            </label>
            <textarea
              value={form.content}
              onChange={(e) => set("content", e.target.value)}
              placeholder={"## Introduction\n\nStart writing your post here...\n\n## What changed\n\nExplain the feature or update."}
              rows={32}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 placeholder-zinc-700 font-mono leading-relaxed focus:border-violet-500 focus:outline-none resize-y"
            />
            <p className="mt-1.5 text-xs text-zinc-700">
              Supports Markdown: **bold**, *italic*, `code`, ```blocks```, ## headings, - lists
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Minimal markdown → HTML for preview (no external dep needed)
function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    // code blocks
    .replace(/```[\w]*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    // headings
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // bold / italic / inline code
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // links
    .replace(/\[(.+?)\]\((.+?)\)/g, (_, text, url) => {
      const safe = url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/");
      return safe ? `<a href="${url}">${text}</a>` : text;
    })
    // hr
    .replace(/^---$/gm, "<hr>")
    // unordered lists (simple)
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>")
    // paragraphs
    .split(/\n\n+/)
    .map((block) => {
      if (/^<(h[1-6]|ul|pre|hr)/.test(block.trim())) return block;
      return `<p>${block.replace(/\n/g, " ")}</p>`;
    })
    .join("\n");
}
