"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, ExternalLink, AlertTriangle, Copy, Sparkles } from "lucide-react";

/**
 * Preview Fix panel — two-tier visual preview of an autonomous remediation.
 *
 * Mounted on the alert detail page when the latest remediation is completed
 * and merged. On mount: POST /api/alerts/:id/preview (idempotent), then
 * polls GET /api/preview/:id every 2s until both tiers reach a terminal
 * state (or 10min cap).
 *
 * Tier 3 (AI prediction) typically resolves in 2-3s; Tier 1 (live Docker
 * deploy) in 30-60s. Progressive disclosure: the prediction iframe renders
 * as soon as it's ready; the live URL card fades in when the container is
 * up.
 *
 * Note: this MVP uses polling instead of SSE. SSE streaming + log ticker
 * land in Session 2.
 */

type PreviewResponse = {
  id: string;
  publicSlug: string;
  live: {
    status: "pending" | "provisioning" | "building" | "running" | "failed" | "expired";
    url: string | null;
    error: string | null;
    buildLogs: string | null;
    expiresAt: string | null;
    readyAt: string | null;
  };
  prediction: {
    status: "pending" | "rendering" | "ready" | "failed" | "skipped";
    error: string | null;
    html: string | null;
    originalHtml: string | null;
    summary: string | null;
    confidence: number | null;
  };
  eapReceiptId: string | null;
  createdAt: string;
  revokedAt: string | null;
};

type CreateResponse = PreviewResponse & {
  shareUrl: string;
  streamUrl: string;
};

type PanelProps = {
  alertId: string;
  remediationSessionId: string;
  eapReceiptId: string | null;
  projectName: string;
};

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 10 * 60 * 1000;

export function PreviewPanel({ alertId, eapReceiptId: initialReceipt }: PanelProps) {
  const [state, setState] = useState<
    | { kind: "creating" }
    | { kind: "ready"; data: PreviewResponse; shareUrl: string }
    | { kind: "error"; message: string }
  >({ kind: "creating" });
  const [activeTab, setActiveTab] = useState<"prediction" | "live">("prediction");
  const [copied, setCopied] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Kick off creation on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/alerts/${alertId}/preview`, { method: "POST" });
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          setState({
            kind: "error",
            message: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
          });
          return;
        }
        const data = (await res.json()) as CreateResponse;
        setState({
          kind: "ready",
          data,
          shareUrl: data.shareUrl,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [alertId]);

  // Poll until both tiers terminal.
  const previewId = state.kind === "ready" ? state.data.id : null;
  useEffect(() => {
    if (!previewId) return;
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (!mountedRef.current) return;
      if (Date.now() - start > MAX_POLL_MS) return;

      try {
        const res = await fetch(`/api/preview/${previewId}`);
        if (!res.ok) return;
        const data = (await res.json()) as PreviewResponse;
        if (!mountedRef.current) return;
        setState((prev) => {
          if (prev.kind !== "ready") return prev;
          return { ...prev, data };
        });
        const bothTerminal =
          isTerminalLive(data.live.status) && isTerminalPrediction(data.prediction.status);
        if (bothTerminal) return;
      } catch {
        // Swallow transient errors — keep polling.
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [previewId]);

  // Auto-flip tab when prediction becomes ready before live.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const d = state.data;
    if (d.prediction.status === "ready" && d.live.status !== "running" && activeTab !== "prediction") {
      setActiveTab("prediction");
    }
    if (d.live.status === "running" && d.prediction.status !== "ready" && activeTab !== "live") {
      setActiveTab("live");
    }
  }, [state, activeTab]);

  const shareUrl = state.kind === "ready" ? state.shareUrl : null;
  const receipt = state.kind === "ready" ? state.data.eapReceiptId : initialReceipt;

  const copyShareUrl = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [shareUrl]);

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-fg-base/50">
            Preview Fix
          </div>
          <h2 className="mt-0.5 text-sm font-semibold text-fg-strong">
            See the autonomous fix before it lands in production
          </h2>
        </div>
        {receipt && (
          <a
            href={`/attestation/${receipt}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 transition-colors"
          >
            <ShieldCheck className="h-3 w-3" aria-hidden />
            Verified
          </a>
        )}
      </header>

      {state.kind === "creating" && <CreatingShimmer />}
      {state.kind === "error" && <ErrorPanel message={state.message} />}
      {state.kind === "ready" && (
        <>
          <TabBar
            active={activeTab}
            onChange={setActiveTab}
            predictionReady={state.data.prediction.status === "ready"}
            liveReady={state.data.live.status === "running"}
            predictionStatus={state.data.prediction.status}
            liveStatus={state.data.live.status}
          />

          <div className="mt-3">
            {activeTab === "prediction" ? (
              <PredictionView data={state.data.prediction} />
            ) : (
              <LiveView data={state.data.live} />
            )}
          </div>

          {shareUrl && (
            <footer className="mt-3 flex items-center gap-2 border-t border-line/60 pt-3 text-[11px] text-fg-base/70">
              <span className="font-mono truncate">{shareUrl}</span>
              <button
                type="button"
                onClick={copyShareUrl}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface-inner px-2 py-1 text-[10px] font-medium text-fg-base/80 hover:text-fg-strong"
              >
                <Copy className="h-3 w-3" aria-hidden />
                {copied ? "Copied" : "Share"}
              </button>
            </footer>
          )}
        </>
      )}
    </section>
  );
}

function CreatingShimmer() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-inner px-4 py-4 text-xs text-fg-base/60">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      Spinning up preview…
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
      <div>
        <p className="font-medium text-red-700 dark:text-red-300">Preview unavailable</p>
        <p className="mt-1 text-fg-base/70">{message}</p>
      </div>
    </div>
  );
}

function TabBar({
  active,
  onChange,
  predictionReady,
  liveReady,
  predictionStatus,
  liveStatus,
}: {
  active: "prediction" | "live";
  onChange: (t: "prediction" | "live") => void;
  predictionReady: boolean;
  liveReady: boolean;
  predictionStatus: string;
  liveStatus: string;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      <TabButton
        active={active === "prediction"}
        onClick={() => onChange("prediction")}
        label="AI prediction"
        statusDot={statusDotTone(predictionStatus, predictionReady ? "ready" : null)}
        subtext={shortPredictionStatus(predictionStatus)}
      />
      <TabButton
        active={active === "live"}
        onClick={() => onChange("live")}
        label="Live build"
        statusDot={statusDotTone(liveStatus, liveReady ? "running" : null)}
        subtext={shortLiveStatus(liveStatus)}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  statusDot,
  subtext,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  statusDot: "green" | "amber" | "muted" | "red";
  subtext: string;
}) {
  const dotClass =
    statusDot === "green"
      ? "bg-emerald-500"
      : statusDot === "amber"
        ? "bg-amber-500 animate-pulse"
        : statusDot === "red"
          ? "bg-red-500"
          : "bg-fg-base/30";
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={onClick}
      className={`group relative flex items-center gap-2 px-3 py-2 text-[11px] font-medium transition-colors ${
        active
          ? "text-fg-strong after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-inari-accent"
          : "text-fg-base/60 hover:text-fg-strong"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
      <span>{label}</span>
      <span className="text-fg-base/40">{subtext}</span>
    </button>
  );
}

function PredictionView({
  data,
}: {
  data: PreviewResponse["prediction"];
}) {
  if (data.status === "pending" || data.status === "rendering") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-inner px-4 py-6 text-xs text-fg-base/60">
        <Sparkles className="h-3.5 w-3.5 animate-pulse text-inari-accent" aria-hidden />
        AI is predicting the fix output — this usually takes 2–3 seconds…
      </div>
    );
  }
  if (data.status === "skipped") {
    return (
      <div className="rounded-xl border border-line bg-surface-inner px-4 py-3 text-xs text-fg-base/70">
        AI preview requires a session recording. Showing the live build only.
      </div>
    );
  }
  if (data.status === "failed" || !data.html) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <div>
          <p className="font-medium text-amber-700 dark:text-amber-300">AI preview unavailable</p>
          {data.error && <p className="mt-1 text-fg-base/70">{data.error}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-white">
      <iframe
        srcDoc={data.html}
        sandbox="allow-same-origin"
        title="AI-predicted preview of the fix"
        className="h-[560px] w-full"
      />
      <div className="pointer-events-none absolute bottom-2 right-2 rounded-md border border-line bg-surface/90 px-2 py-1 text-[10px] text-fg-base/70 backdrop-blur-sm">
        AI-predicted · may differ from live
      </div>
      {data.summary && (
        <div className="border-t border-line bg-surface-inner px-3 py-2 text-[11px] text-fg-base/70">
          {data.summary}
        </div>
      )}
    </div>
  );
}

function LiveView({ data }: { data: PreviewResponse["live"] }) {
  if (data.status === "running" && data.url) {
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="flex items-center gap-2 border-b border-line bg-surface-inner px-3 py-2 text-[11px] text-fg-base/80">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
          <span className="font-mono truncate">{data.url}</span>
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-[10px] font-medium text-fg-base/80 hover:text-fg-strong"
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            Open
          </a>
        </div>
        <iframe
          src={data.url}
          sandbox="allow-scripts allow-forms allow-same-origin"
          title="Live preview of the fixed application"
          className="h-[560px] w-full"
        />
      </div>
    );
  }
  if (data.status === "failed") {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium text-red-700 dark:text-red-300">Live build failed</p>
            {data.error && <p className="mt-1 text-fg-base/70 break-words">{data.error}</p>}
          </div>
        </div>
        {data.buildLogs && (
          <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-black/5 p-2 text-[10px] font-mono text-fg-base/80 dark:bg-white/5">
            {data.buildLogs.slice(-4000)}
          </pre>
        )}
      </div>
    );
  }
  if (data.status === "expired") {
    return (
      <div className="rounded-xl border border-line bg-surface-inner px-4 py-3 text-xs text-fg-base/70">
        This preview has expired. The 24h window closed — the fix itself is still merged in production.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-surface-inner px-4 py-4 text-xs text-fg-base/70">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        <span>
          {data.status === "building"
            ? "Building the fix branch in an isolated container…"
            : "Provisioning preview container…"}
        </span>
      </div>
      <div className="mt-1.5 text-[10px] text-fg-base/50">Usually 30–60 seconds.</div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isTerminalLive(s: string): boolean {
  return s === "running" || s === "failed" || s === "expired";
}
function isTerminalPrediction(s: string): boolean {
  return s === "ready" || s === "failed" || s === "skipped";
}

function statusDotTone(
  status: string,
  target: string | null,
): "green" | "amber" | "red" | "muted" {
  if (target && status === target) return "green";
  if (status === "failed") return "red";
  if (status === "skipped" || status === "expired") return "muted";
  return "amber";
}

function shortPredictionStatus(s: string): string {
  switch (s) {
    case "pending":
      return "queued";
    case "rendering":
      return "rendering…";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    case "skipped":
      return "n/a";
    default:
      return s;
  }
}

function shortLiveStatus(s: string): string {
  switch (s) {
    case "pending":
      return "queued";
    case "provisioning":
      return "provisioning…";
    case "building":
      return "building…";
    case "running":
      return "ready";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    default:
      return s;
  }
}

export default PreviewPanel;
