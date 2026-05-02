import { motion, useReducedMotion } from "framer-motion";
import { Sparkles, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ChatMessage } from "@/components/ChatMessage";
import { Button, KbdHint } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useChat, type ChatMessage as ChatMessageT } from "@/lib/store/chat";

const SCROLL_BOTTOM_TOLERANCE = 16;

const EMPTY_PROMPTS = [
  "Why is auth failing?",
  "Find places where we hash passwords",
  "Explain this regression",
];

function detectPatch(message: ChatMessageT | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  // Heuristic — assistant prose contains a fenced diff/code block AND
  // mentions "patch" / "diff" / "apply". Accurate enough for the
  // contextual footer; the cloud agent surface (Sesión 19) replaces this
  // with a structured tool-call result.
  const content = message.content.toLowerCase();
  const hasFence = content.includes("```");
  if (!hasFence) return false;
  return (
    content.includes("patch") ||
    content.includes("diff") ||
    content.includes("apply") ||
    content.includes("fix")
  );
}

interface DockConversationProps {
  /**
   * Auto-focus the input on mount. True in production (transition from
   * idle). Tests pass false to avoid jsdom focus complaints.
   */
  autoFocusInput?: boolean;
}

/**
 * Dock Mode 2 — conversation. Renders the live thread, an input that
 * persists `useChat.inputValue`, and a contextual footer keyed off the
 * last AI message. Auto-scrolls to bottom on new tokens UNLESS the user
 * has manually scrolled up — re-engages once they return to the bottom.
 */
export function DockConversation({ autoFocusInput = true }: DockConversationProps) {
  const messages = useChat((s) => s.messages);
  const inputValue = useChat((s) => s.inputValue);
  const setInputValue = useChat((s) => s.setInputValue);
  const sendMessage = useChat((s) => s.sendMessage);
  const replayLast = useChat((s) => s.replayLast);
  const clearConversation = useChat((s) => s.clearConversation);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickyBottom, setStickyBottom] = useState(true);
  const reduce = useReducedMotion();

  const lastMessage = messages[messages.length - 1];
  const lastAssistant = useMemo(
    () => [...messages].reverse().find((m) => m.role === "assistant"),
    [messages],
  );
  const showApplyFix = useMemo(() => detectPatch(lastAssistant), [lastAssistant]);

  // Auto-scroll on token append, only while the user is anchored to
  // the bottom. The total content height is the only thing that
  // changes per-token; we measure it via `scrollHeight`.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickyBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, stickyBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    setStickyBottom(distanceFromBottom <= SCROLL_BOTTOM_TOLERANCE);
  }, []);

  useEffect(() => {
    if (autoFocusInput) {
      inputRef.current?.focus();
    }
  }, [autoFocusInput]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    sendMessage(inputValue);
    // Re-anchor on send — explicit user action implies they want to
    // see the response at the bottom.
    setStickyBottom(true);
  };

  const isEmpty = messages.length === 0;

  return (
    <div data-testid="dock-conversation" className="flex flex-col h-full">
      {/* Top — input + clear */}
      <div className="flex items-center gap-3 px-6 h-14 border-b border-[var(--border-subtle)]">
        <Sparkles className="h-4 w-4 text-[var(--accent)]" aria-hidden />
        <form onSubmit={onSubmit} className="flex-1 flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Ask Inari…"
            aria-label="Inari prompt"
            data-testid="dock-conversation-input"
            className="flex-1 h-9 bg-transparent text-[15px] text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none border-none"
          />
        </form>
        <button
          type="button"
          onClick={clearConversation}
          aria-label="Clear conversation"
          data-testid="dock-conversation-clear"
          className={cn(
            "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
            "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--card)]",
            "transition-colors duration-[var(--duration-fast)] cursor-pointer",
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          )}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body — thread or empty state */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="dock-conversation-scroll"
        className="flex-1 overflow-auto px-6 py-4"
      >
        {isEmpty ? (
          <div
            data-testid="dock-conversation-empty"
            className="h-full flex flex-col items-center justify-center text-center gap-3"
          >
            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="text-3xl text-[var(--accent)]"
              aria-hidden
            >
              ✦
            </motion.div>
            <h2 className="font-[var(--font-serif)] text-[18px] text-[var(--text)]">
              Inari is ready
            </h2>
            <ul className="flex flex-col gap-2 text-[13px] text-[var(--text-muted)] max-w-[40ch]">
              {EMPTY_PROMPTS.map((prompt) => (
                <li key={prompt}>
                  <button
                    type="button"
                    onClick={() => {
                      setInputValue(prompt);
                      sendMessage(prompt);
                    }}
                    className="hover:text-[var(--accent-light)] transition-colors duration-[var(--duration-fast)] cursor-pointer focus:outline-none focus-visible:underline"
                  >
                    “{prompt}”
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul className="flex flex-col gap-4 min-h-full">
            {messages.map((message) => (
              <li key={message.id}>
                <ChatMessage message={message} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer — contextual to last AI message */}
      <footer
        className="flex items-center justify-between gap-2 px-6 h-12 border-t border-[var(--border-subtle)]"
        data-testid="dock-conversation-footer"
      >
        <div className="flex items-center gap-2">
          {showApplyFix ? (
            <>
              <Button
                size="sm"
                variant="primary"
                data-testid="action-apply-fix"
                onClick={() =>
                  console.info("[dock] apply fix — Sesión 16/19 wires this")
                }
              >
                Apply fix
              </Button>
              <Button
                size="sm"
                variant="secondary"
                data-testid="action-show-diff"
                onClick={() =>
                  console.info("[dock] show diff — Sesión 16 wires this")
                }
              >
                Show diff
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            data-testid="action-tell-me-more"
            onClick={() => {
              if (!lastMessage) return;
              if (lastMessage.role === "user") {
                replayLast();
              } else {
                sendMessage("Tell me more about that.");
              }
            }}
          >
            Tell me more
          </Button>
        </div>
        <span className="text-[11px] text-[var(--text-muted)]">
          <KbdHint>ESC</KbdHint> to close
        </span>
      </footer>
    </div>
  );
}
