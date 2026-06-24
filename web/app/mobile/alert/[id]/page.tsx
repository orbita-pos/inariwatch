/**
 * S12 — /mobile/alert/[id]
 *
 * Per-alert detail view + Fix button + chat thread. The chat is a
 * skinny wrapper over /api/mobile/chat (non-streamed for simplicity;
 * the streaming endpoint is wired but used by /mobile/inbox in S12.5
 * when assistant typing UX matters more).
 */

"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

const TOKEN_KEY = "inari.mobile.deviceToken";

interface AlertDetail {
  id:                 string;
  title:              string;
  body:               string;
  severity:           string;
  ai_reasoning:       string | null;
  source_integrations: string[];
  fingerprint:        string | null;
  is_read:            boolean;
  is_resolved:        boolean;
  repo:               string | null;
  project: { id: string; name: string; slug: string };
  remediations: {
    id:         string;
    status:     string;
    attempt:    number;
    pr_url:     string | null;
    created_at: string;
  }[];
  created_at: string;
}

interface ChatMsg {
  role:    "user" | "assistant";
  content: string;
}

export default function MobileAlertDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id     = params.id;

  const [token, setToken]         = useState<string | null>(null);
  const [alert, setAlert]         = useState<AlertDetail | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [messages, setMessages]   = useState<ChatMsg[]>([]);
  const [draft, setDraft]         = useState("");
  const [thinking, setThinking]   = useState(false);
  const [fixState, setFixState]   = useState<"idle" | "starting" | "started" | "error">("idle");

  useEffect(() => {
    const t = window.localStorage.getItem(TOKEN_KEY);
    if (!t) {
      router.replace("/mobile/pair");
      return;
    }
    setToken(t);
  }, [router]);

  useEffect(() => {
    if (!token || !id) return;
    let cancelled = false;
    const fetchAlert = async () => {
      try {
        const r = await fetch(`/api/mobile/alerts/${id}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (r.status === 401) {
          window.localStorage.removeItem(TOKEN_KEY);
          router.replace("/mobile/pair");
          return;
        }
        if (!r.ok) {
          if (!cancelled) setError(`HTTP ${r.status}`);
          return;
        }
        const j = (await r.json()) as AlertDetail;
        if (!cancelled) setAlert(j);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      }
    };
    void fetchAlert();
    return () => { cancelled = true; };
  }, [token, id, router]);

  const triggerFix = async () => {
    if (!token || !alert) return;
    setFixState("starting");
    try {
      const r = await fetch(`/api/mobile/alerts/${alert.id}/fix`, {
        method:  "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        setFixState("error");
        return;
      }
      setFixState("started");
    } catch {
      setFixState("error");
    }
  };

  const sendChat = async () => {
    if (!token || !draft.trim()) return;
    const userMsg: ChatMsg = { role: "user", content: draft.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    setThinking(true);
    try {
      const r = await fetch("/api/mobile/chat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ alert_id: id, prompt: userMsg.content }),
      });
      if (!r.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: `Error: HTTP ${r.status}` }]);
      } else {
        const j = (await r.json()) as ChatMsg;
        setMessages((prev) => [...prev, j]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: e instanceof Error ? e.message : "Network error" },
      ]);
    } finally {
      setThinking(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 px-4 py-6">
      <header className="flex items-center gap-3">
        <Link href="/mobile/inbox" className="text-sm opacity-70">
          ← Inbox
        </Link>
      </header>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {!alert && !error ? (
        <p data-testid="alert-loading" className="text-sm opacity-60">
          Loading…
        </p>
      ) : null}

      {alert ? (
        <article data-testid="alert-detail" className="flex flex-col gap-3">
          <div>
            <span className="text-xs uppercase opacity-60">{alert.severity}</span>
            <h1 className="text-lg font-semibold leading-tight">{alert.title}</h1>
            <p className="text-xs opacity-50">
              {alert.project.name} · {new Date(alert.created_at).toLocaleString()}
            </p>
          </div>
          {alert.body ? (
            <pre className="whitespace-pre-wrap rounded-md border border-white/10 bg-white/5 p-3 text-xs">
              {alert.body}
            </pre>
          ) : null}
          {alert.ai_reasoning ? (
            <section className="rounded-md border border-white/10 bg-white/5 p-3 text-sm">
              <h2 className="mb-1 text-xs uppercase opacity-60">AI analysis</h2>
              <p>{alert.ai_reasoning}</p>
            </section>
          ) : null}

          <button
            data-testid="alert-fix-button"
            onClick={() => void triggerFix()}
            disabled={fixState === "starting"}
            className="rounded-md bg-[#f0c544] px-4 py-3 text-sm font-medium text-black disabled:opacity-60"
          >
            {fixState === "starting" ? "Starting fix…" :
             fixState === "started"  ? "Fix queued" :
             fixState === "error"    ? "Try again" :
                                        "Trigger Fix"}
          </button>

          {alert.remediations.length > 0 ? (
            <section>
              <h2 className="mb-1 text-xs uppercase opacity-60">Recent fixes</h2>
              <ul className="flex flex-col gap-1 text-xs">
                {alert.remediations.map((r) => (
                  <li
                    key={r.id}
                    className="rounded border border-white/10 bg-white/5 px-2 py-1"
                  >
                    {r.status} · attempt {r.attempt}
                    {r.pr_url ? <> · <a href={r.pr_url} target="_blank" rel="noreferrer" className="underline">PR</a></> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section data-testid="alert-chat" className="flex flex-col gap-2">
            <h2 className="text-xs uppercase opacity-60">Ask Inari</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {messages.map((m, i) => (
                <li
                  key={i}
                  data-testid={`alert-chat-msg-${i}`}
                  className={
                    m.role === "user"
                      ? "self-end rounded-md bg-[#f0c544]/20 px-3 py-2"
                      : "self-start rounded-md bg-white/10 px-3 py-2"
                  }
                >
                  {m.content}
                </li>
              ))}
              {thinking ? <li className="opacity-50">Thinking…</li> : null}
            </ul>
            <div className="flex gap-2">
              <input
                data-testid="alert-chat-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendChat();
                  }
                }}
                placeholder="Ask about this alert…"
                className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
              />
              <button
                data-testid="alert-chat-send"
                onClick={() => void sendChat()}
                disabled={thinking || !draft.trim()}
                className="rounded-md bg-white/10 px-3 py-2 text-sm disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </section>
        </article>
      ) : null}
    </main>
  );
}
