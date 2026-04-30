import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ToolCallCard } from "@/components/ToolCallCard";
import { cn } from "@/lib/cn";
import type { ChatMessage as ChatMessageT } from "@/lib/store/chat";

interface ChatMessageProps {
  message: ChatMessageT;
}

interface MessageBlock {
  kind: "text" | "code";
  /** Free-form prose for `text`, raw source for `code`. */
  content: string;
  /** Lower-case language id for `code`, undefined for `text`. */
  language?: string;
}

/**
 * Lightweight markdown segmentation. Handles fenced code blocks
 * (```lang\n...\n```) and leaves everything else as a text block. We
 * deliberately do NOT pull in `react-markdown` here for two reasons:
 *
 *   1. The dock's chat surface is constrained — the only structured
 *      element we render right now is fenced code; bullets / headings /
 *      links can come later via a markdown renderer if Sesión 16 ships
 *      one. Cost-of-context is too high to add it speculatively.
 *   2. Streaming. `react-markdown` reflows on every token because it
 *      reparses the entire string; a hand-rolled segmenter parses only
 *      whole code fences, leaving streamed text as a single growing
 *      `<p>` so layout doesn't twitch.
 */
function segmentMessage(content: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const fence = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    if (match.index > cursor) {
      blocks.push({ kind: "text", content: content.slice(cursor, match.index) });
    }
    blocks.push({
      kind: "code",
      content: match[2] ?? "",
      language: (match[1] ?? "").trim().toLowerCase() || "txt",
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    blocks.push({ kind: "text", content: content.slice(cursor) });
  }
  return blocks;
}

interface CodeBlockProps {
  language: string;
  code: string;
}

/**
 * Render a code block. Highlighting via Shiki is loaded lazily; while
 * the highlighter boots we render plain monospace so the block doesn't
 * flash white. Copy button uses `navigator.clipboard.writeText` and
 * shows a 1.5s "Copied" affordance.
 */
function CodeBlock({ language, code }: CodeBlockProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const html = await codeToHtml(code, {
          lang: language === "txt" ? "plaintext" : language,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        });
        if (!cancelled) setHighlighted(html);
      } catch {
        // Unknown language or shiki failure — fall back to plain text.
        if (!cancelled) setHighlighted(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silently fail — copy buttons that throw a modal on permission
      // denial feel hostile. The user can always select-and-copy.
    }
  };

  return (
    <div
      className={cn(
        "group relative my-2 rounded-[var(--radius-md)]",
        "border border-[var(--border)] bg-[var(--surface)]",
        "overflow-hidden font-[var(--font-mono)] text-xs",
      )}
    >
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy code"
        className={cn(
          "absolute right-1.5 top-1.5 z-10",
          "inline-flex items-center gap-1 px-1.5 py-1",
          "rounded-[var(--radius-sm)] border border-[var(--border)]",
          "bg-[var(--bg)] text-[var(--muted)]",
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          "transition-opacity duration-[var(--duration-fast)]",
          "hover:text-[var(--text)]",
        )}
      >
        {copied ? (
          <>
            <Check className="h-3 w-3 text-[var(--color-success)]" aria-hidden />
            <span className="text-[0.65rem]">Copied</span>
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" aria-hidden />
            <span className="text-[0.65rem]">Copy</span>
          </>
        )}
      </button>
      {highlighted ? (
        <div
          className="p-3 [&_pre]:!bg-transparent [&_pre]:m-0 overflow-auto"
          // Shiki emits a self-contained <pre><code> tree with inline
          // styles for tokens. The output is escaped at source — no
          // injection risk from message content.
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="p-3 m-0 overflow-auto text-[var(--text)]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/**
 * Render one chat message. User messages right-aligned in Inter; AI
 * messages left-aligned in Source Serif 4. Fenced code blocks render
 * with Shiki + a copy affordance. Tool calls render below the prose.
 */
export function ChatMessage({ message }: ChatMessageProps) {
  const blocks = useMemo(() => segmentMessage(message.content), [message.content]);
  const isUser = message.role === "user";

  return (
    <div
      data-testid={`chat-message-${message.role}`}
      data-streaming={message.streaming ? "true" : undefined}
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[85%] px-3 py-2 rounded-[var(--radius-lg)]",
          "text-sm leading-relaxed",
          isUser
            ? "bg-[var(--surface)] text-[var(--text)] font-[var(--font-sans)]"
            : "bg-transparent text-[var(--text)] font-[var(--font-serif)]",
        )}
      >
        {blocks.length === 0 || (blocks.length === 1 && blocks[0]!.content === "") ? (
          <span className="text-[var(--muted)] italic">
            {message.streaming ? "Inari is thinking…" : ""}
          </span>
        ) : null}
        {blocks.map((block, idx) => {
          if (block.kind === "code") {
            return (
              <CodeBlock
                key={idx}
                language={block.language ?? "txt"}
                code={block.content}
              />
            );
          }
          return (
            <p
              key={idx}
              className="whitespace-pre-wrap"
              data-testid="chat-message-text"
            >
              {block.content}
              {message.streaming && idx === blocks.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    "ml-[1px] inline-block w-[6px] h-[1em] align-[-0.1em]",
                    "bg-[var(--color-ai)] animate-pulse",
                  )}
                />
              ) : null}
            </p>
          );
        })}

        {message.toolCalls && message.toolCalls.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1.5">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
