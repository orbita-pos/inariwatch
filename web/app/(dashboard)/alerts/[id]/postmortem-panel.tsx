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
  alertId: string;
  postmortem: string | null;
  isResolved: boolean;
  hasAIKey: boolean;
}) {
  const [content, setContent] = useState(postmortem);
  const [error, setError] = useState("");
  const [isPending, start] = useTransition();

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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `postmortem-${alertId.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Only show for resolved alerts with AI key
  if (!isResolved || !hasAIKey) return null;

  return (
    <section className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <FileText className={`h-3.5 w-3.5 ${content ? "text-violet-400" : "text-zinc-600"}`} />
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Post-mortem</span>
          {content && (
            <span className="rounded-full bg-violet-400/10 px-2 py-0.5 text-[10px] font-medium text-violet-400">
              Generated
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {content && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded-lg border border-line-medium bg-surface-dim px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-fg-strong hover:border-zinc-600 transition-all"
            >
              <Download className="h-3 w-3" />
              Export .md
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={isPending}
            className="flex items-center gap-1.5 rounded-lg border border-line-medium bg-surface-dim px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-fg-strong hover:border-zinc-600 transition-all disabled:opacity-50"
          >
            {isPending ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Generating…
              </>
            ) : content ? (
              <>
                <RotateCcw className="h-3 w-3" />
                Regenerate
              </>
            ) : (
              <>
                <FileText className="h-3 w-3" />
                Generate
              </>
            )}
          </button>
        </div>
      </div>

      <div className="px-5 py-5">
        {isPending && !content && (
          <div className="flex items-center gap-2 text-sm text-zinc-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating post-mortem…
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {content && !isPending && (
          <div className="prose prose-invert prose-sm max-w-none prose-headings:text-zinc-200 prose-p:text-zinc-400 prose-li:text-zinc-400 prose-strong:text-zinc-300">
            <PostmortemMarkdown content={content} />
          </div>
        )}

        {!content && !isPending && !error && (
          <p className="text-sm text-zinc-600">
            Generate an AI post-mortem with timeline, root cause, impact analysis, and prevention measures.
          </p>
        )}
      </div>
    </section>
  );
}

/** Simple markdown renderer for post-mortems (## headers, **bold**, - lists, paragraphs) */
function PostmortemMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      elements.push(<h2 key={key++} className="text-base font-semibold text-zinc-200 mt-4 mb-2">{line.slice(3)}</h2>);
    } else if (line.startsWith("- ")) {
      elements.push(
        <div key={key++} className="flex gap-2 text-sm text-zinc-400 pl-2">
          <span className="text-zinc-600 shrink-0">•</span>
          <span>{formatBold(line.slice(2))}</span>
        </div>
      );
    } else if (line.trim() === "") {
      elements.push(<div key={key++} className="h-2" />);
    } else {
      elements.push(<p key={key++} className="text-sm text-zinc-400 leading-relaxed">{formatBold(line)}</p>);
    }
  }

  return <>{elements}</>;
}

function formatBold(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="text-zinc-300 font-medium">{part}</strong> : part
  );
}
