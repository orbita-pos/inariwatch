"use client";

import { useState, useTransition } from "react";
import { FileText, Loader2, Download, RotateCcw } from "lucide-react";
import { generatePostmortemAction } from "./postmortem-actions";

export function PostmortemPanel({
  alertId,
  postmortem,
  isResolved,
  hasAIKey,
}: {
  alertId:    string;
  postmortem: string | null;
  isResolved: boolean;
  hasAIKey:   boolean;
}) {
  const [content, setContent] = useState(postmortem);
  const [error, setError]     = useState("");
  const [isPending, start]    = useTransition();

  function handleGenerate() {
    setError("");
    start(async () => {
      const res = await generatePostmortemAction(alertId);
      if (res.error) setError(res.error);
      else if (res.postmortem) setContent(res.postmortem);
    });
  }

  function handleDownload() {
    if (!content) return;
    const blob = new Blob([content], { type: "text/markdown" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `postmortem-${alertId.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Only show for resolved alerts with AI key
  if (!isResolved) return null;

  return (
    <section
      aria-labelledby="postmortem-heading"
      className="rounded-xl border border-line bg-surface overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <FileText
            className={`h-3.5 w-3.5 ${content ? "text-violet-600 dark:text-violet-400" : "text-fg-base/60"}`}
            aria-hidden="true"
          />
          <h2 id="postmortem-heading" className="text-xs font-medium uppercase tracking-wider text-fg-base/70">
            Post-mortem
          </h2>
          {content && (
            <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-400">
              Generated
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {content && (
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded-lg border border-line-medium bg-surface-dim px-3 py-1.5 text-xs font-medium text-fg-base hover:text-fg-strong hover:border-line hover:bg-surface transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
              aria-label="Download post-mortem as markdown file"
            >
              <Download className="h-3 w-3" aria-hidden="true" />
              Export .md
            </button>
          )}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isPending}
            aria-busy={isPending}
            aria-describedby="postmortem-heading"
            className="flex items-center gap-1.5 rounded-lg border border-line-medium bg-surface-dim px-3 py-1.5 text-xs font-medium text-fg-base hover:text-fg-strong hover:border-line hover:bg-surface transition-all disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
          >
            {isPending ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                Generating…
              </>
            ) : content ? (
              <>
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                Regenerate
              </>
            ) : (
              <>
                <FileText className="h-3 w-3" aria-hidden="true" />
                Generate
              </>
            )}
          </button>
        </div>
      </div>

      <div className="px-5 py-5" aria-live="polite">
        {isPending && !content && (
          <div role="status" className="flex items-center gap-2 text-sm text-fg-base">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Generating post-mortem…
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {content && !isPending && (
          <PostmortemMarkdown content={content} />
        )}

        {!content && !isPending && !error && (
          <p className="text-sm text-fg-base/70">
            Generate an AI post-mortem with timeline, root cause, impact analysis, and prevention measures.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Simple markdown renderer for post-mortems.
 * Supports: ## headers, **bold**, - lists, paragraphs.
 * Groups consecutive bullets into a semantic <ul> so screen readers announce list structure.
 */
function PostmortemMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={`ul-${key++}`} className="my-2 space-y-1 pl-1">
        {listItems}
      </ul>
    );
    listItems = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushList();
      elements.push(
        <h3 key={key++} className="text-base font-semibold text-fg-strong mt-5 mb-2 first:mt-0">
          {line.slice(3)}
        </h3>
      );
    } else if (line.startsWith("- ")) {
      listItems.push(
        <li key={`li-${key++}`} className="flex gap-2 text-sm text-fg-base leading-relaxed">
          <span className="text-fg-base/50 shrink-0" aria-hidden="true">•</span>
          <span>{formatBold(line.slice(2))}</span>
        </li>
      );
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      elements.push(
        <p key={key++} className="text-sm text-fg-base leading-relaxed my-2">
          {formatBold(line)}
        </p>
      );
    }
  }
  flushList();

  return <div className="max-w-none">{elements}</div>;
}

function formatBold(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1
      ? <strong key={i} className="text-fg-strong font-semibold">{part}</strong>
      : part
  );
}
