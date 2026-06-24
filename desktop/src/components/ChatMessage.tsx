import { Check, Copy, KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { StacktraceText } from "@/components/context-menu/StacktraceText";
import { DiffCard } from "@/components/DiffCard";
import {
  ChannelAttributionChip,
  isMessengerSource,
} from "@/components/messenger/ChannelAttributionChip";
import { ToolCallCard } from "@/components/ToolCallCard";
import { PlayerCard } from "@/components/PlayerCard";
import { InariMark } from "@/screens/MainWindow";
import { cn } from "@/lib/cn";
import { useChat, type ChatMessage as ChatMessageT, type ToolCall } from "@/lib/store/chat";

interface ChatMessageProps {
  message: ChatMessageT;
  /**
   * True when this is the most recent assistant message. Drives the
   * inline action-row affordance — only the latest assistant turn that
   * proposes a fix shows Apply / Show diff / Tell me more, so older
   * proposals don't clutter the scrollback.
   */
  isLatestAssistant?: boolean;
}

interface MessageBlock {
  kind: "text" | "code";
  /** Free-form prose for `text`, raw source for `code`. */
  content: string;
  /** Lower-case language id for `code`, undefined for `text`. */
  language?: string;
}

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
      // silent
    }
  };

  return (
    <div
      className={cn(
        "group relative my-3 rounded-[10px]",
        "overflow-hidden font-[var(--font-mono)] text-[12.5px]",
      )}
      style={{
        background: "#0c0c10",
        border: "1px solid var(--border)",
      }}
    >
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy code"
        className={cn(
          "absolute right-2 top-2 z-10",
          "inline-flex items-center gap-1 px-1.5 py-1 rounded-[6px]",
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          "transition-opacity duration-[var(--duration-fast)]",
        )}
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          color: "var(--text-muted)",
        }}
      >
        {copied ? (
          <>
            <Check className="h-3 w-3" style={{ color: "var(--verified)" }} aria-hidden />
            <span className="text-[10.5px]">Copied</span>
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" aria-hidden />
            <span className="text-[10.5px]">Copy</span>
          </>
        )}
      </button>
      {highlighted ? (
        <div
          className="p-3 [&_pre]:!bg-transparent [&_pre]:m-0 overflow-auto"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="p-3 m-0 overflow-auto" style={{ color: "var(--syn-id)" }}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/**
 * Heuristic — does the assistant prose look like it's proposing a
 * patch the user can apply? Triggers the inline action row in the
 * latest assistant turn (Apply fix / Show diff / Tell me more).
 *
 * Cheap test: contains a fenced code block AND mentions one of
 * patch/diff/apply/fix. Accurate enough for the affordance; the real
 * proposal-detection moves to a structured tool-call result in a
 * later phase (Phase B/C wires `propose.fix` as a typed tool).
 */
function detectPatchProposal(content: string): boolean {
  const lower = content.toLowerCase();
  if (!lower.includes("```")) return false;
  return (
    lower.includes("patch") ||
    lower.includes("diff") ||
    lower.includes("apply") ||
    lower.includes("fix")
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Pick the witness id that backs the proposed fix — the most recent
 * `done` tool-call invocationId, since that's the receipt the user
 * would inspect when deciding whether to trust the patch. Falls back
 * to a deterministic short id derived from the message id so the chip
 * has SOMETHING to render even before the proposal flow is wired.
 */
function deriveWitnessLabel(message: ChatMessageT): { hash: string; verified: boolean } {
  const tcs = message.toolCalls ?? [];
  const lastDone = [...tcs].reverse().find((tc) => tc.status === "done" && tc.invocationId);
  if (lastDone?.invocationId) {
    const short = lastDone.invocationId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
    return { hash: `w_${short}`, verified: true };
  }
  const idHash = message.id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return { hash: `w_${idHash || "pending"}`, verified: false };
}

interface InlineActionRowProps {
  message: ChatMessageT;
}

function InlineActionRow({ message }: InlineActionRowProps) {
  const sendMessage = useChat((s) => s.sendMessage);
  const replayLast = useChat((s) => s.replayLast);
  const witness = deriveWitnessLabel(message);

  // All three buttons are prompt shortcuts — same pattern as
  // "Tell me more". The agent receives a natural-language request and
  // chains its existing tools (local_exec.write_file, run_shell git
  // commands, etc.) to fulfil it. Cryptographic witness wraps every
  // tool call regardless of how the user triggered it. A future
  // structured `propose.fix` tool with a typed payload can replace
  // these prompts when it lands; the buttons stay the same.
  return (
    <div className="flex items-center gap-2 mt-3.5 flex-wrap">
      <button
        type="button"
        data-testid="action-apply-fix"
        className={cn(
          "h-9 px-3.5 rounded-lg text-[13px] font-medium flex items-center gap-2",
          "transition-transform active:scale-[0.98]",
        )}
        style={{
          background: "var(--accent)",
          color: "var(--accent-ink)",
          border: "1px solid rgba(0,0,0,0.18)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.08), 0 1px 0 rgba(0,0,0,0.45)",
        }}
        onClick={() => sendMessage("Apply that fix.")}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 12l2 2 4-4" />
          <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9c2.39 0 4.68.95 6.36 2.64" />
        </svg>
        Apply fix
      </button>
      <button
        type="button"
        data-testid="action-show-diff"
        className="h-9 px-3.5 rounded-lg text-[13px] transition-colors hover:bg-white/[0.025]"
        style={{
          background: "transparent",
          color: "var(--text-muted)",
          border: "1px solid var(--border-strong)",
        }}
        onClick={() => sendMessage("Show me the full diff.")}
      >
        Show diff
      </button>
      <button
        type="button"
        data-testid="action-tell-me-more"
        className="h-9 px-3.5 rounded-lg text-[13px] transition-colors hover:bg-white/[0.025]"
        style={{
          background: "transparent",
          color: "var(--text-muted)",
          border: "1px solid var(--border-strong)",
        }}
        onClick={() => {
          if (message.role === "user") {
            replayLast();
          } else {
            sendMessage("Tell me more about that.");
          }
        }}
      >
        Tell me more
      </button>
      <span
        className="ml-auto inline-flex items-center gap-1.5"
        data-testid="message-witness-chip"
        style={{
          height: 22,
          padding: "0 8px 0 7px",
          borderRadius: 999,
          background: witness.verified
            ? "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))"
            : "transparent",
          border: `1px solid ${witness.verified ? "rgba(166,194,176,0.18)" : "var(--border)"}`,
          color: witness.verified ? "var(--verified)" : "var(--text-subtle)",
          fontSize: 11,
          opacity: witness.verified ? 1 : 0.55,
        }}
      >
        <KeyRound size={11} strokeWidth={1.6} />
        <span style={{ color: witness.verified ? "rgba(166,194,176,0.78)" : undefined }}>
          {witness.verified ? "verified" : "awaiting receipt"}
        </span>
        {witness.verified ? (
          <>
            <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "#C8DDD0",
                letterSpacing: "0.01em",
              }}
            >
              {witness.hash}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

interface AssistantHeaderProps {
  createdAt: number;
}

function AssistantHeader({ createdAt }: AssistantHeaderProps) {
  return (
    <div
      className="flex items-center gap-2 mb-3"
      style={{ fontSize: 11.5, color: "var(--text-dim)" }}
    >
      <InariMark size={10} />
      <span style={{ color: "var(--text-muted)" }}>Inari</span>
      <span style={{ color: "var(--text-faint)" }}>·</span>
      <span>{formatTime(createdAt)}</span>
    </div>
  );
}

/**
 * Render one chat message. Per the 2026-05-07 chat-first reframe:
 *
 *  - User turns are right-aligned bubbles (asymmetric corners, soft
 *    gradient on `--surface-2 → --surface`).
 *  - Assistant turns are full-width prose anchored only by a tiny
 *    Inari mark + timestamp header. No bubble, no avatar.
 *  - Tool calls render inline INSIDE the assistant turn (not in a
 *    separate bubble). Multiple tool calls stack with a small gap.
 *  - When the assistant proposes a fix and this is the latest
 *    assistant turn, render the `InlineActionRow` directly below the
 *    prose — Apply fix / Show diff / Tell me more / witness chip.
 *
 * `StacktraceText` still wraps prose so right-click + hover surfaces
 * keep working on file:line references.
 */
export function ChatMessage({ message, isLatestAssistant = false }: ChatMessageProps) {
  const blocks = useMemo(() => segmentMessage(message.content), [message.content]);
  const isUser = message.role === "user";
  const showActionRow = !isUser && isLatestAssistant && detectPatchProposal(message.content);

  if (isUser) {
    return (
      <div
        data-testid="chat-message-user"
        data-streaming={message.streaming ? "true" : undefined}
        className="flex justify-end w-full"
      >
        <div
          className="max-w-[480px] px-4 py-2.5"
          style={{
            background: "linear-gradient(180deg, #1c1c22, #181820)",
            border: "1px solid var(--border-strong)",
            color: "var(--text)",
            borderRadius: "14px 14px 4px 14px",
          }}
        >
          <div
            className="text-[14.5px] leading-[1.55]"
            style={{ letterSpacing: "-0.005em" }}
          >
            <StacktraceText
              text={message.content}
              testId={`chat-msg-${message.id}-user`}
            />
          </div>
          {isMessengerSource(message.source) ? (
            <div className="mt-2">
              <ChannelAttributionChip source={message.source} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="chat-message-assistant"
      data-streaming={message.streaming ? "true" : undefined}
      className="w-full"
    >
      <AssistantHeader createdAt={message.createdAt} />

      <div
        className="text-[14.5px] leading-[1.65] space-y-3.5"
        style={{ color: "var(--text)", letterSpacing: "-0.005em" }}
      >
        {blocks.length === 0 || (blocks.length === 1 && blocks[0]!.content === "") ? (
          <span className="italic" style={{ color: "var(--text-dim)" }}>
            {message.streaming ? "Inari is thinking…" : ""}
          </span>
        ) : null}
        {blocks.map((block, idx) => {
          if (block.kind === "code") {
            // 2026-05-07 chat-first design: fenced ```diff blocks get
            // a richer card (file header + line counts + collapsible
            // unified-diff body) instead of a plain code block. Other
            // languages still use Shiki.
            if (block.language === "diff") {
              return <DiffCard key={idx} diff={block.content} />;
            }
            if (block.language === "player") {
              const hash = block.content.trim();
              return <PlayerCard key={idx} hash={hash} />;
            }
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
              <StacktraceText
                text={block.content}
                testId={`chat-msg-${message.id}-block-${idx}`}
              />
              {message.streaming && idx === blocks.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    "ml-[1px] inline-block w-[6px] h-[1em] align-[-0.1em] animate-pulse",
                  )}
                  style={{ background: "var(--accent)" }}
                />
              ) : null}
            </p>
          );
        })}
      </div>

      {message.toolCalls && message.toolCalls.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2.5">
          {message.toolCalls.map((tc: ToolCall) => (
            <ToolCallCard
              key={tc.id}
              messageId={message.id}
              toolCall={tc}
            />
          ))}
        </div>
      ) : null}

      {showActionRow ? <InlineActionRow message={message} /> : null}

      {isMessengerSource(message.source) ? (
        <div className="mt-3">
          <ChannelAttributionChip source={message.source} />
        </div>
      ) : null}
    </div>
  );
}
