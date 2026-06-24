"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Sparkles,
  Copy,
} from "lucide-react";
import type { PreviewSession } from "@/lib/db";

/**
 * Public preview viewer — client component for /preview/<slug>.
 *
 * Given a preview slug, polls the public endpoint every 2s until both tiers
 * reach a terminal state. Unlike the authed embedded panel, this component
 * is designed for a full-page context: larger iframes, prominent Verified
 * badge, Copy URL affordance.
 */

type PublicPreviewResponse = {
  publicSlug: string;
  live: {
    status: "pending" | "provisioning" | "building" | "running" | "failed" | "expired";
    url: string | null;
    readyAt: string | null;
    expiresAt: string | null;
  };
  prediction: {
    status: "pending" | "rendering" | "ready" | "failed" | "skipped";
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
  };
  eapReceiptId: string | null;
  createdAt: string;
};

const POLL_MS = 2000;
const MAX_POLL_MS = 10 * 60 * 1000;

export function PreviewViewer({
  slug,
  initialPreview,
}: {
  slug: string;
  initialPreview: Pick<PreviewSession, "id" | "publicSlug" | "liveStatus" | "predictionStatus" | "eapReceiptId">;
}) {
  const [data, setData] = useState<PublicPreviewResponse | null>(null);
  const [activeTab, setActiveTab] = useState<"prediction" | "live">(
    initialPreview.predictionStatus === "ready" ? "prediction" :
    initialPreview.liveStatus === "running" ? "live" : "prediction",
  );
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Initial fetch + polling until both tiers terminal.
  useEffect(() => {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (!mountedRef.current) return;
      if (Date.now() - start > MAX_POLL_MS) return;

      try {
        const res = await fetch(`/api/preview/slug/${slug}`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          timer = setTimeout(tick, POLL_MS);
          return;
        }
        const next = (await res.json()) as PublicPreviewResponse;
        if (!mountedRef.current) return;
        setData(next);
        const bothDone =
          isTerminalLive(next.live.status) && isTerminalPrediction(next.prediction.status);
        if (bothDone) return;
      } catch {
        // transient — keep polling
      }
      timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => { if (timer) clearTimeout(timer); };
  }, [slug]);

  // Auto-switch tabs as tiers become ready.
  useEffect(() => {
    if (!data) return;
    if (data.prediction.status === "ready" && data.live.status !== "running" && activeTab !== "prediction") {
      setActiveTab("prediction");
    } else if (data.live.status === "running" && data.prediction.status !== "ready" && activeTab !== "live") {
      setActiveTab("live");
    }
  }, [data, activeTab]);

  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}/preview/${slug}` : `/preview/${slug}`;

  const copyShareUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [shareUrl]);

  const prediction = data?.prediction;
  const live = data?.live;
  const receipt = data?.eapReceiptId ?? initialPreview.eapReceiptId;

  return (
    <div className="space-y-4">
      {receipt && (
        <a
          href={`/attestation/${receipt}`}
          className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 transition-colors hover:bg-emerald-500/10"
        >
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-fg-strong">Verified by InariWatch</div>
            <div className="mt-0.5 break-all font-mono text-[11px] text-fg-base/60">
              {receipt.slice(0, 24)}… · Merkle-rooted, Ed25519-signed
            </div>
          </div>
          <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            view chain →
          </span>
        </a>
      )}

      <div className="rounded-xl border border-line bg-surface overflow-hidden">
        <div role="tablist" className="flex border-b border-line">
          <TabButton
            active={activeTab === "prediction"}
            onClick={() => setActiveTab("prediction")}
            label="AI prediction"
            status={prediction?.status ?? initialPreview.predictionStatus}
            target="ready"
          />
          <TabButton
            active={activeTab === "live"}
            onClick={() => setActiveTab("live")}
            label="Live build"
            status={live?.status ?? initialPreview.liveStatus}
            target="running"
          />
        </div>

        <div>
          {activeTab === "prediction" ? (
            <PredictionBody prediction={prediction ?? null} initialStatus={initialPreview.predictionStatus} />
          ) : (
            <LiveBody
              live={live ?? null}
              screenshot={data?.screenshot}
              initialStatus={initialPreview.liveStatus}
            />
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-[11px]">
        <span className="text-fg-base/50 uppercase tracking-wider">Share</span>
        <code className="min-w-0 flex-1 truncate font-mono text-fg-base/80">{shareUrl}</code>
        <button
          type="button"
          onClick={copyShareUrl}
          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-inner px-2 py-1 text-[10px] font-medium text-fg-base/80 hover:text-fg-strong"
        >
          <Copy className="h-3 w-3" aria-hidden />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  status,
  target,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  status: string;
  target: string;
}) {
  const dotClass =
    status === target
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "skipped" || status === "expired"
          ? "bg-fg-base/30"
          : "bg-amber-500 animate-pulse";
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={onClick}
      className={`group relative flex items-center gap-2 px-4 py-3 text-xs font-medium transition-colors ${
        active
          ? "text-fg-strong after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-inari-accent"
          : "text-fg-base/60 hover:text-fg-strong"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

function PredictionBody({
  prediction,
  initialStatus,
}: {
  prediction: PublicPreviewResponse["prediction"] | null;
  initialStatus: string;
}) {
  const status = prediction?.status ?? initialStatus;
  if (status === "pending" || status === "rendering") {
    return (
      <div className="flex items-center gap-2 px-6 py-16 text-sm text-fg-base/60">
        <Sparkles className="h-3.5 w-3.5 animate-pulse text-inari-accent" aria-hidden />
        AI is predicting the fix output — this usually takes 2–3 seconds…
      </div>
    );
  }
  if (status === "skipped") {
    return (
      <div className="px-6 py-6 text-sm text-fg-base/70">
        AI preview requires a session recording at the moment of the bug. This
        alert didn&apos;t have one — switch to the Live build tab to see the real
        fix in action.
      </div>
    );
  }
  if (status === "failed" || !prediction?.html) {
    return (
      <div className="flex items-start gap-2 px-6 py-4 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <div>
          <p className="font-medium text-amber-700 dark:text-amber-300">AI preview unavailable</p>
          <p className="mt-1 text-fg-base/70">
            Try the Live build tab — that renders the real fix, not a prediction.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="relative">
      <iframe
        srcDoc={prediction.html}
        sandbox="allow-same-origin"
        title="AI-predicted preview of the fix"
        className="h-[720px] w-full bg-white"
      />
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-line bg-surface/90 px-2 py-1 text-[10px] text-fg-base/70 backdrop-blur-sm">
        AI-predicted · may differ from live
      </div>
      {prediction.summary && (
        <div className="border-t border-line bg-surface-inner px-4 py-3 text-[11px] text-fg-base/70">
          {prediction.summary}
        </div>
      )}
    </div>
  );
}

function LiveBody({
  live,
  screenshot,
  initialStatus,
}: {
  live: PublicPreviewResponse["live"] | null;
  screenshot?: PublicPreviewResponse["screenshot"];
  initialStatus: string;
}) {
  const status = live?.status ?? initialStatus;
  const [showIframe, setShowIframe] = useState(false);
  if (status === "running" && live?.url) {
    const url = live.url;
    const hasShot = !!screenshot?.url;
    if (showIframe) {
      return (
        <div>
          <div className="flex items-center gap-2 border-b border-line bg-surface-inner px-4 py-2 text-[11px]">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
            <code className="min-w-0 flex-1 truncate font-mono text-fg-base/80">{url}</code>
            <button
              type="button"
              onClick={() => setShowIframe(false)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-[10px] font-medium text-fg-base/80 hover:text-fg-strong"
            >
              Back to preview
            </button>
          </div>
          <iframe
            src={url}
            sandbox="allow-scripts allow-forms allow-same-origin"
            title="Live preview of the fixed application"
            className="h-[720px] w-full bg-white"
          />
        </div>
      );
    }
    return (
      <div className="relative">
        {hasShot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={screenshot!.url!}
            alt="Live preview of the fixed application"
            width={screenshot?.width ?? 1280}
            height={screenshot?.height ?? 800}
            className="block h-auto w-full bg-surface-inner"
            loading="eager"
          />
        ) : (
          <div
            className="flex w-full items-center justify-center bg-surface-inner text-[12px] text-fg-base/60"
            style={{ aspectRatio: "1280 / 800" }}
          >
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Capturing preview screenshot…
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/60 via-black/20 to-transparent p-5">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-fg-strong shadow transition hover:bg-white/95"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            Open live preview
          </a>
          <button
            type="button"
            onClick={() => setShowIframe(true)}
            className="pointer-events-auto rounded-md border border-white/30 bg-black/40 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm hover:bg-black/50"
          >
            Try embedded view
          </button>
        </div>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="px-6 py-6 text-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
          <div>
            <p className="font-medium text-red-700 dark:text-red-300">Live build failed</p>
            <p className="mt-1 text-fg-base/70">
              The container couldn&apos;t start. Try the AI prediction tab for a
              static render of the fix.
            </p>
          </div>
        </div>
      </div>
    );
  }
  if (status === "expired") {
    return (
      <div className="px-6 py-6 text-sm text-fg-base/70">
        This live preview expired after 24 hours. The fix itself is still merged
        in production.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-6 py-16 text-sm text-fg-base/70">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      <span>
        {status === "building"
          ? "Building the fix branch in an isolated container… usually 30–60 seconds."
          : "Provisioning preview container…"}
      </span>
    </div>
  );
}

function isTerminalLive(s: string): boolean {
  return s === "running" || s === "failed" || s === "expired";
}
function isTerminalPrediction(s: string): boolean {
  return s === "ready" || s === "failed" || s === "skipped";
}
