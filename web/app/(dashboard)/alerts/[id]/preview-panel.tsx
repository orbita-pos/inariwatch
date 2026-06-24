"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Loader2, ShieldCheck, ExternalLink, AlertTriangle, Copy, Sparkles, Ban } from "lucide-react";
import { toast } from "sonner";

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
  screenshot?: {
    url: string | null;
    takenAt: string | null;
    width: number | null;
    height: number | null;
    error?: string | null;
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
        // After Tier 1 reaches `running` the screenshot capture is still
        // in flight — keep polling a bit longer so the image appears
        // in-place. `screenshotPending` is bounded by the live timeout
        // above; if capture fails, `screenshot_error` is set and we stop.
        const screenshotPending =
          data.live.status === "running" &&
          !data.screenshot?.url &&
          !data.screenshot?.error;
        if (bothTerminal && !screenshotPending) return;
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

  const revokedAt = state.kind === "ready" ? state.data.revokedAt : null;
  const [revokePending, startRevoke] = useTransition();

  const revoke = useCallback(() => {
    if (!previewId) return;
    if (!confirm("Revoke the public share URL? Anyone holding it will see a 410 Gone page. The live preview and screenshot stay on this page.")) {
      return;
    }
    startRevoke(async () => {
      try {
        const res = await fetch(`/api/preview/${previewId}/revoke`, { method: "POST" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? "Failed to revoke");
          return;
        }
        toast.success("Share URL revoked");
        setState((prev) => {
          if (prev.kind !== "ready") return prev;
          return {
            ...prev,
            data: { ...prev.data, revokedAt: new Date().toISOString() },
          };
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to revoke");
      }
    });
  }, [previewId]);

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
              <LiveView data={state.data.live} screenshot={state.data.screenshot} />
            )}
          </div>

          {shareUrl && (
            <footer className="mt-3 flex items-center gap-2 border-t border-line/60 pt-3 text-[11px] text-fg-base/70">
              <span className={`font-mono truncate ${revokedAt ? "line-through opacity-50" : ""}`}>
                {shareUrl}
              </span>
              {revokedAt ? (
                <span className="ml-auto inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-600 dark:text-red-300">
                  <Ban className="h-3 w-3" aria-hidden />
                  Revoked
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={copyShareUrl}
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface-inner px-2 py-1 text-[10px] font-medium text-fg-base/80 hover:text-fg-strong"
                  >
                    <Copy className="h-3 w-3" aria-hidden />
                    {copied ? "Copied" : "Share"}
                  </button>
                  <button
                    type="button"
                    onClick={revoke}
                    disabled={revokePending}
                    title="Revoke the public share URL"
                    className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-inner px-2 py-1 text-[10px] font-medium text-fg-base/60 hover:border-red-400/40 hover:text-red-500 disabled:opacity-50"
                  >
                    <Ban className="h-3 w-3" aria-hidden />
                    {revokePending ? "Revoking…" : "Revoke"}
                  </button>
                </>
              )}
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

function LiveView({
  data,
  screenshot,
}: {
  data: PreviewResponse["live"];
  screenshot?: PreviewResponse["screenshot"];
}) {
  if (data.status === "running" && data.url) {
    return <RunningLiveView url={data.url} screenshot={screenshot} />;
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

/**
 * Hero card shown when Tier 1 is `running`.
 *
 * Two-stage reveal:
 *   1. Default — screenshot + big "Open live preview" CTA. Works in every
 *      browser (no iframe cross-origin blocks, no tracking-prevention
 *      surprises), loads instantly from CDN.
 *   2. Opt-in — "Try embedded view" toggle drops in the iframe for users
 *      whose browser permits it. Kept off by default because Edge / Brave
 *      / Safari / Firefox-ETP routinely block cross-origin iframes.
 *
 * Before the screenshot lands we show a skeleton with the same aspect
 * ratio, so the card doesn't layout-shift when the image arrives.
 */
function RunningLiveView({
  url,
  screenshot,
}: {
  url: string;
  screenshot?: PreviewResponse["screenshot"];
}) {
  const [showIframe, setShowIframe] = useState(false);
  const hasScreenshot = !!screenshot?.url;
  const screenshotErrored = !!screenshot?.error;
  const aspect =
    screenshot?.width && screenshot?.height
      ? `${screenshot.width} / ${screenshot.height}`
      : "1280 / 800";

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white dark:bg-surface">
      <div className="flex items-center gap-2 border-b border-line bg-surface-inner px-3 py-2 text-[11px] text-fg-base/80">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
        <span className="font-mono truncate">{url}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-[10px] font-medium text-fg-base/80 hover:text-fg-strong"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          Open
        </a>
      </div>

      {showIframe ? (
        <iframe
          src={url}
          sandbox="allow-scripts allow-forms allow-same-origin"
          title="Live preview of the fixed application"
          className="h-[560px] w-full bg-white"
        />
      ) : hasScreenshot ? (
        // Screenshot is ready: hero card with the real render + overlay CTAs.
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={screenshot!.url!}
            alt="Live preview of the fixed application"
            width={screenshot?.width ?? 1280}
            height={screenshot?.height ?? 800}
            className="block max-h-[560px] w-full object-contain bg-surface-inner"
            loading="eager"
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/60 via-black/20 to-transparent p-3">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-900 shadow transition hover:bg-white/95"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              Open live preview
            </a>
            <button
              type="button"
              onClick={() => setShowIframe(true)}
              className="pointer-events-auto rounded-md border border-white/20 bg-black/30 px-2 py-1 text-[10px] font-medium text-white/90 backdrop-blur-sm hover:bg-black/40"
            >
              Try embedded view
            </button>
          </div>
        </div>
      ) : (
        // Capturing: skeleton + centered primary CTA so the user can jump to
        // the live preview in a new tab without waiting for the screenshot.
        // The skeleton holds the card's final aspect ratio so there's no
        // layout shift when the image arrives.
        <div
          className="relative w-full bg-surface-inner"
          style={{ aspectRatio: aspect }}
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-fg-strong px-5 py-2.5 text-sm font-semibold text-bg shadow transition hover:opacity-90"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Open live preview
            </a>
            {screenshotErrored ? (
              <div className="text-[11px] text-fg-base/50">
                Screenshot unavailable — the live URL still works.
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[11px] text-fg-base/60">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Capturing screenshot in the background…
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowIframe(true)}
              className="text-[10px] text-fg-base/50 underline-offset-4 hover:underline"
            >
              Try embedded view
            </button>
          </div>
        </div>
      )}
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
