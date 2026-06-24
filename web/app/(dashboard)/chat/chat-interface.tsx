"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { MessageSquare, Send, Loader2, Sparkles, User, Trash2 } from "lucide-react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const SUGGESTIONS = [
  "What's the current state of my systems?",
  "Show me all unresolved critical alerts",
  "What caused the most incidents this month?",
  "Are any of my integrations having issues?",
  "Summarize the last remediation that ran",
];

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load from localStorage after hydration
  useEffect(() => {
    try {
      const stored = localStorage.getItem("inari-chat-history");
      setMessages(stored ? JSON.parse(stored) : []);
    } catch { setMessages([]); }
  }, []);

  // Persist to localStorage on every change
  useEffect(() => {
    if (messages === null) return;
    try { localStorage.setItem("inari-chat-history", JSON.stringify(messages)); } catch { /* ignore */ }
  }, [messages]);

  useEffect(() => {
    if (messages !== null) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (messages !== null) inputRef.current?.focus();
  }, [messages]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming || messages === null) return;

    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", content: text.trim() };
    const assistantMsg: Message = { id: `a_${Date.now()}`, role: "assistant", content: "" };

    setMessages((prev) => [...(prev ?? []), userMsg, assistantMsg]);
    setInput("");
    setIsStreaming(true);

    const allMessages = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));

    try {
      abortRef.current = new AbortController();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: allMessages }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        setMessages((prev) =>
          (prev ?? []).map((m) => (m.id === assistantMsg.id ? { ...m, content: `Error: ${err}` } : m))
        );
        setIsStreaming(false);
        return;
      }

      // Check if it's a streaming response or JSON
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        setMessages((prev) =>
          (prev ?? []).map((m) => (m.id === assistantMsg.id ? { ...m, content: data.content } : m))
        );
        setIsStreaming(false);
        return;
      }

      // Stream SSE
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                setMessages((prev) =>
                  (prev ?? []).map((m) =>
                    m.id === assistantMsg.id ? { ...m, content: (m.content ?? "") + parsed.content } : m
                  )
                );
              }
              if (parsed.error) {
                setMessages((prev) =>
                  (prev ?? []).map((m) =>
                    m.id === assistantMsg.id ? { ...m, content: `Error: ${parsed.error}` } : m
                  )
                );
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) =>
          (prev ?? []).map((m) =>
            m.id === assistantMsg.id ? { ...m, content: "Connection failed. Please try again." } : m
          )
        );
      }
    }

    setIsStreaming(false);
  }, [isStreaming, messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  function handleClear() {
    if (isStreaming) {
      abortRef.current?.abort();
      setIsStreaming(false);
    }
    setMessages([]);
    try { localStorage.removeItem("inari-chat-history"); } catch { /* ignore */ }
  }

  if (messages === null) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto min-h-0 py-4 space-y-4 px-2">
          {[80, 55, 90, 60, 75].map((w, i) => (
            <div key={i} className={`flex gap-3 ${i % 2 === 0 ? "" : "flex-row-reverse"}`}>
              <div className="h-6 w-6 shrink-0 rounded-full bg-black/[0.08] dark:bg-white/[0.05] animate-pulse" />
              <div className="h-4 rounded-lg bg-black/[0.08] dark:bg-white/[0.05] animate-pulse" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t border-line pt-3 pb-3">
          <div className="h-11 w-full rounded-xl bg-black/[0.08] dark:bg-white/[0.05] animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full space-y-6">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-inari-accent/10 mb-2">
                <Sparkles className="h-6 w-6 text-inari-accent" aria-hidden="true" />
              </div>
              <h2 className="text-lg font-semibold text-fg-strong">Ask Inari anything</h2>
              <p className="text-sm text-fg-base/60 max-w-md">
                Chat with your monitoring data. Ask about alerts, incidents, system health, and patterns.
              </p>
            </div>

            {/* Suggestions */}
            <div className="flex flex-wrap justify-center gap-2 max-w-lg">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => sendMessage(s)}
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg-base/60 hover:text-fg-strong hover:border-fg-base/30 transition-all"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-1 py-4">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-3 px-2 py-3 ${
                msg.role === "assistant" ? "bg-white/[0.02]" : ""
              } rounded-lg`}>
                <div className="mt-0.5 shrink-0">
                  {msg.role === "user" ? (
                    <div className="h-6 w-6 rounded-full bg-surface-dim flex items-center justify-center">
                      <User className="h-3.5 w-3.5 text-fg-base/50" aria-hidden="true" />
                    </div>
                  ) : (
                    <div className="h-6 w-6 rounded-full bg-inari-accent/10 flex items-center justify-center">
                      <Sparkles className="h-3.5 w-3.5 text-inari-accent" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  {msg.role === "assistant" && !msg.content && isStreaming ? (
                    <div className="flex items-center gap-2 text-sm text-fg-base/50">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      Thinking…
                    </div>
                  ) : (
                    <div className="text-sm text-fg-base leading-relaxed whitespace-pre-wrap break-words">
                      <ChatMarkdown content={msg.content} />
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-line pt-3 pb-3">
        <form onSubmit={handleSubmit}>
          <div className="flex gap-2" style={{ alignItems: "stretch" }}>
            <div className="relative flex-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your systems..."
                disabled={isStreaming}
                rows={1}
                className="w-full resize-none overflow-hidden rounded-xl border border-line bg-surface px-4 py-3 pr-12 text-sm text-fg-strong placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none disabled:opacity-50 transition-colors"
                style={{ maxHeight: "120px", minHeight: "44px", display: "block" }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 120) + "px";
                }}
              />
              <button
                type="submit"
                disabled={!input.trim() || isStreaming}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-inari-accent p-1.5 text-white disabled:opacity-30 hover:bg-inari-accent/80 transition-colors"
              >
                {isStreaming ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {messages.length > 0 && messages !== null && (
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={handleClear}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-line text-fg-base/50 hover:text-fg-base hover:border-fg-base/30 transition-colors"
                  aria-label="Clear chat"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </form>
        <p className="mt-2 text-center text-[10px] text-fg-base/40">
          InariWatch AI queries your real monitoring data. Responses may not always be accurate.
        </p>
      </div>
    </div>
  );
}

/** Simple markdown renderer for chat messages */
function ChatMarkdown({ content }: { content: string }) {
  if (!content) return null;
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let key = 0;
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        elements.push(
          <pre key={key++} className="my-2 rounded-lg bg-surface-dim border border-line p-3 overflow-x-auto">
            <code className="text-xs text-fg-base font-mono">{codeLines.join("\n")}</code>
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.startsWith("### ")) {
      elements.push(<h3 key={key++} className="text-sm font-semibold text-fg-strong mt-3 mb-1">{formatInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={key++} className="text-base font-semibold text-fg-strong mt-4 mb-2">{formatInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={key++} className="text-lg font-semibold text-fg-strong mt-4 mb-2">{formatInline(line.slice(2))}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <div key={key++} className="flex gap-2 pl-2 text-sm text-fg-base">
          <span className="text-fg-base/40 shrink-0">•</span>
          <span>{formatInline(line.slice(2))}</span>
        </div>
      );
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)$/);
      if (match) {
        elements.push(
          <div key={key++} className="flex gap-2 pl-2 text-sm text-fg-base">
            <span className="text-fg-base/60 shrink-0 tabular-nums">{match[1]}.</span>
            <span>{formatInline(match[2])}</span>
          </div>
        );
      }
    } else if (line.trim() === "") {
      elements.push(<div key={key++} className="h-2" />);
    } else if (line.startsWith("> ")) {
      elements.push(
        <div key={key++} className="border-l-2 border-fg-base/20 pl-3 my-1 text-sm text-fg-base/50 italic">
          {formatInline(line.slice(2))}
        </div>
      );
    } else {
      elements.push(<p key={key++} className="text-sm text-fg-base leading-relaxed">{formatInline(line)}</p>);
    }
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    elements.push(
      <pre key={key++} className="my-2 rounded-lg bg-surface-dim border border-line p-3 overflow-x-auto">
        <code className="text-xs text-fg-base font-mono">{codeLines.join("\n")}</code>
      </pre>
    );
  }

  return <>{elements}</>;
}

function formatInline(text: string): React.ReactNode {
  // Handle **bold**, *italic*, `code`, and [links](url)
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let i = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/^\*\*(.*?)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={i++} className="text-fg-strong font-medium">{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Inline code
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(
        <code key={i++} className="rounded bg-surface-dim border border-line px-1.5 py-0.5 text-xs font-mono text-fg-base/60">
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      parts.push(<em key={i++} className="text-fg-base/60">{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Regular text (consume until next special char)
    const nextSpecial = remaining.search(/[*`\[]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      // Special char not matched by patterns above — treat as literal
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}
