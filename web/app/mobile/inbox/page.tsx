/**
 * S12 — /mobile/inbox
 *
 * Streams alerts via SSE from `/api/mobile/alerts/stream`. Tap an
 * alert → navigate to /mobile/alert/[id]. Pull-to-refresh is left
 * to the platform; the SSE auto-streams new alerts within ~5s.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface AlertRow {
  id:                 string;
  title:              string;
  body:               string;
  severity:           string;
  ai_reasoning:       string | null;
  source_integrations: string[];
  is_read:            boolean;
  is_resolved:        boolean;
  fingerprint:        string | null;
  project_id:         string;
  created_at:         string;
}

const TOKEN_KEY = "inari.mobile.deviceToken";

export default function MobileInboxPage() {
  const router = useRouter();
  const [alerts, setAlerts]       = useState<AlertRow[]>([]);
  const [status, setStatus]       = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg]   = useState<string | null>(null);
  const tokenRef                  = useRef<string | null>(null);

  useEffect(() => {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) {
      router.replace("/mobile/pair");
      return;
    }
    tokenRef.current = token;

    let abort = new AbortController();
    let cancelled = false;

    const run = async () => {
      try {
        const res = await fetch("/api/mobile/alerts/stream", {
          headers: { authorization: `Bearer ${token}` },
          signal:  abort.signal,
        });
        if (res.status === 401) {
          window.localStorage.removeItem(TOKEN_KEY);
          router.replace("/mobile/pair");
          return;
        }
        if (!res.ok || !res.body) {
          setStatus("error");
          setErrorMsg(`HTTP ${res.status}`);
          return;
        }
        setStatus("ready");

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        const seen = new Map<string, AlertRow>();

        while (!cancelled) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });

          let idx;
          // SSE framing — events end with \n\n.
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let eventName = "message";
            let dataLine  = "";
            for (const ln of raw.split("\n")) {
              if (ln.startsWith("event: ")) eventName = ln.slice(7).trim();
              else if (ln.startsWith("data: ")) dataLine = ln.slice(6);
            }
            if (eventName === "alert" && dataLine.length > 0) {
              try {
                const alert = JSON.parse(dataLine) as AlertRow;
                seen.set(alert.id, alert);
                setAlerts(
                  Array.from(seen.values()).sort((a, b) =>
                    a.created_at < b.created_at ? 1 : -1,
                  ),
                );
              } catch {
                // ignore malformed event
              }
            }
          }
        }
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setErrorMsg(e instanceof Error ? e.message : "Network error");
      }
    };
    void run();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [router]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Alerts</h1>
        <Link
          href="/mobile/pair"
          className="text-xs opacity-60 underline-offset-2 hover:underline"
        >
          Re-pair
        </Link>
      </header>

      {status === "loading" ? (
        <p data-testid="inbox-loading" className="text-sm opacity-60">
          Connecting…
        </p>
      ) : null}
      {status === "error" ? (
        <p data-testid="inbox-error" className="text-sm text-red-400">
          {errorMsg ?? "Unable to load alerts."}
        </p>
      ) : null}
      {status === "ready" && alerts.length === 0 ? (
        <p data-testid="inbox-empty" className="text-sm opacity-60">
          No alerts yet.
        </p>
      ) : null}

      <ul data-testid="inbox-list" className="flex flex-col gap-2">
        {alerts.map((a) => (
          <li key={a.id}>
            <Link
              href={`/mobile/alert/${a.id}`}
              data-testid={`inbox-row-${a.id}`}
              className="block rounded-md border border-white/10 bg-white/5 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <SeverityBadge severity={a.severity} />
                <span className="text-xs opacity-50">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-sm font-medium leading-tight">{a.title}</p>
              {a.ai_reasoning ? (
                <p className="mt-1 line-clamp-2 text-xs opacity-70">
                  {a.ai_reasoning}
                </p>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls =
    severity === "critical"
      ? "bg-red-500/20 text-red-300"
      : severity === "warning"
      ? "bg-amber-500/20 text-amber-200"
      : "bg-white/10 text-white/70";
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>
      {severity}
    </span>
  );
}
