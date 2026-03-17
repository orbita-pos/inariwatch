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

export function ChatInterface({ hasAIKey }: { hasAIKey: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", content: text.trim() };
    const assistantMsg: Message = { id: `a_${Date.now()}`, role: "assistant", content: "" };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
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
          prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: `Error: ${err}` } : m))
        );
        setIsStreaming(false);
        return;
      }

      // Check if it's a streaming response or JSON
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: data.content } : m))
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
                  prev.map((m) =>
                    m.id === assistantMsg.id ? { ...m, content: m.content + parsed.content } : m
                  )
                );
              }
              if (parsed.error) {
                setMessages((prev) =>
                  prev.map((m) =>
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
          prev.map((m) =>
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
  }

  if (!hasAIKey) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <MessageSquare className="h-10 w-10 text-zinc-700 mx-auto" />
          <h2 className="text-lg font-semibold text-white">Ask Inari</h2>
          <p className="text-sm text-zinc-500 max-w-sm">
            Add a Claude or OpenAI API key in{" "}
            <a href="/settings" className="text-inari-accent hover:underline">Settings</a>{" "}
            to chat with your monitoring data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full space-y-6">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-inari-accent/10 mb-2">
                <Sparkles className="h-6 w-6 text-inari-accent" />
              </div>
              <h2 className="text-lg font-semibold text-white">Ask Inari anything</h2>
              <p className="text-sm text-zinc-500 max-w-md">
                Chat with your monitoring data. Ask about alerts, incidents, system health, and patterns.
              </p>
            </div>

            {/* Suggestions */}
            <div className="flex flex-wrap justify-center gap-2 max-w-lg">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="rounded-lg border border-[#1a1a1a] bg-[#0a0a0a] px-3 py-2 text-xs text-zinc-400 hover:text-white hover:border-zinc-600 transition-all"
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
                    <div className="h-6 w-6 rounded-full bg-zinc-800 flex items-center justify-center">
                      <User className="h-3.5 w-3.5 text-zinc-400" />
                    </div>
                  ) : (
                    <div className="h-6 w-6 rounded-full bg-inari-accent/10 flex items-center justify-center">
                      <Sparkles className="h-3.5 w-3.5 text-inari-accent" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  {msg.role === "assistant" && !msg.content && isStreaming ? (
                    <div className="flex items-center gap-2 text-sm text-zinc-600">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Thinking…
                    </div>
                  ) : (
                    <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">
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
      <div className="shrink-0 border-t border-[#1a1a1a] pt-4 pb-2">
        <form onSubmit={handleSubmit} className="relative">
          <div className="flex items-end gap-2">
            <div className="relative flex-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your systems..."
                disabled={isStreaming}
                rows={1}
                className="w-full resize-none rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3 pr-12 text-sm text-white placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50 transition-colors"
                style={{ maxHeight: "120px", minHeight: "44px" }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 120) + "px";
                }}
              />
              <button
                type="submit"
                disabled={!input.trim() || isStreaming}
                className="absolute right-2 bottom-2 rounded-lg bg-inari-accent p-1.5 text-white disabled:opacity-30 hover:bg-inari-accent/80 transition-colors"
              >
                {isStreaming ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={handleClear}
                className="shrink-0 rounded-lg border border-[#1a1a1a] p-3 text-zinc-600 hover:text-zinc-400 hover:border-zinc-600 transition-colors"
                title="Clear chat"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </form>
        <p className="mt-2 text-center text-[10px] text-zinc-700">
          InariWatch AI queries your real monitoring data. Responses may not always be accurate.
        </p>
      </div>
    </>
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
          <pre key={key++} className="my-2 rounded-lg bg-[#111] border border-[#1a1a1a] p-3 overflow-x-auto">
            <code className="text-xs text-zinc-300 font-mono">{codeLines.join("\n")}</code>
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
      elements.push(<h3 key={key++} className="text-sm font-semibold text-zinc-200 mt-3 mb-1">{formatInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={key++} className="text-base font-semibold text-zinc-200 mt-4 mb-2">{formatInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={key++} className="text-lg font-semibold text-white mt-4 mb-2">{formatInline(line.slice(2))}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <div key={key++} className="flex gap-2 pl-2 text-sm text-zinc-300">
          <span className="text-zinc-600 shrink-0">•</span>
          <span>{formatInline(line.slice(2))}</span>
        </div>
      );
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)$/);
      if (match) {
        elements.push(
          <div key={key++} className="flex gap-2 pl-2 text-sm text-zinc-300">
            <span className="text-zinc-500 shrink-0 tabular-nums">{match[1]}.</span>
            <span>{formatInline(match[2])}</span>
          </div>
        );
      }
    } else if (line.trim() === "") {
      elements.push(<div key={key++} className="h-2" />);
    } else if (line.startsWith("> ")) {
      elements.push(
        <div key={key++} className="border-l-2 border-zinc-700 pl-3 my-1 text-sm text-zinc-500 italic">
          {formatInline(line.slice(2))}
        </div>
      );
    } else {
      elements.push(<p key={key++} className="text-sm text-zinc-300 leading-relaxed">{formatInline(line)}</p>);
    }
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    elements.push(
      <pre key={key++} className="my-2 rounded-lg bg-[#111] border border-[#1a1a1a] p-3 overflow-x-auto">
        <code className="text-xs text-zinc-300 font-mono">{codeLines.join("\n")}</code>
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
      parts.push(<strong key={i++} className="text-zinc-200 font-medium">{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Inline code
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(
        <code key={i++} className="rounded bg-[#111] border border-[#1a1a1a] px-1.5 py-0.5 text-xs font-mono text-zinc-400">
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      parts.push(<em key={i++} className="text-zinc-400">{italicMatch[1]}</em>);
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
