"use client";

/**
 * UpgradeModal — shown when a free user hits their AI quota limit.
 *
 * Usage:
 *   <UpgradeModal
 *     open={isOpen}
 *     onClose={() => setOpen(false)}
 *     feature="remediation"
 *     used={3}
 *     limit={3}
 *   />
 */

import { useState, useTransition } from "react";
import { X, Sparkles, ArrowRight, Check, AlertCircle } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";

const FEATURE_LABELS: Record<string, string> = {
  "auto-analyze": "Auto-analyses",
  "remediation": "AI Remediations",
  "chat": "Ask Inari messages",
  "pr-prediction": "PR Predictions",
  "postmortem": "AI Postmortems",
};

const PRO_QUOTAS = [
  { feature: "Auto-analyses", limit: "3,000/mo", multiplier: "10x" },
  { feature: "AI Remediations", limit: "25/mo", multiplier: "8x" },
  { feature: "Ask Inari", limit: "500/mo", multiplier: "5x" },
  { feature: "PR Predictions", limit: "30/mo", multiplier: "3x" },
  { feature: "AI Postmortems", limit: "50/mo", multiplier: "10x" },
];

export interface UpgradeModalProps {
  open: boolean;
  onClose: () => void;
  /** Which feature triggered the upgrade modal (for context messaging). */
  feature?: string;
  used?: number;
  limit?: number;
  /** Days until quota resets (free users). */
  daysUntilReset?: number;
}

export function UpgradeModal({
  open,
  onClose,
  feature,
  used,
  limit,
  daysUntilReset,
}: UpgradeModalProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleCheckout = async (interval: "monthly" | "annual") => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/billing/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Failed to start checkout");
          return;
        }
        if (data.url) window.location.href = data.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      }
    });
  };

  const featureLabel = feature ? FEATURE_LABELS[feature] ?? feature : null;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface-dim shadow-[0_0_60px_rgba(0,0,0,0.7)] focus:outline-none">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-line">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-inari-accent" />
              <Dialog.Title className="text-base font-semibold text-fg-strong">
                Upgrade to Pro
              </Dialog.Title>
            </div>
            <Dialog.Close className="rounded-md p-1 text-zinc-600 hover:text-fg-base transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="px-6 py-5 space-y-5">
            {/* Limit reached banner */}
            {feature && used != null && limit != null && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="text-fg-strong font-medium">
                    You&apos;ve used all {limit} {featureLabel} this month
                  </p>
                  {daysUntilReset != null && (
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Free quota resets in {daysUntilReset} {daysUntilReset === 1 ? "day" : "days"}.
                      Upgrade now for 10x more.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Pro benefits */}
            <div>
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                Pro plan includes
              </p>
              <ul className="space-y-2">
                {PRO_QUOTAS.map((q) => (
                  <li key={q.feature} className="flex items-baseline justify-between text-sm">
                    <div className="flex items-baseline gap-2">
                      <Check className="h-3.5 w-3.5 text-inari-accent shrink-0 self-center" />
                      <span className="text-fg-base">{q.feature}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-mono text-fg-strong">{q.limit}</span>
                      <span className="ml-2 text-xs text-inari-accent">{q.multiplier}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {/* CTAs */}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleCheckout("monthly")}
                disabled={isPending}
                className="rounded-lg border border-inari-border bg-transparent px-4 py-3 text-left transition-colors hover:bg-surface-inner disabled:opacity-50"
              >
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-fg-strong font-mono">$12</span>
                  <span className="text-xs text-zinc-500">/mo</span>
                </div>
                <div className="mt-1 text-xs text-zinc-500">Monthly billing</div>
              </button>
              <button
                onClick={() => handleCheckout("annual")}
                disabled={isPending}
                className="rounded-lg border-2 border-inari-accent bg-inari-accent/10 px-4 py-3 text-left transition-colors hover:bg-inari-accent/20 disabled:opacity-50 relative"
              >
                <span className="absolute -top-2 right-2 bg-inari-accent text-bg-base text-[9px] font-mono font-bold px-1.5 py-0.5 rounded uppercase">
                  Save $24
                </span>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-fg-strong font-mono">$120</span>
                  <span className="text-xs text-zinc-500">/yr</span>
                </div>
                <div className="mt-1 text-xs text-inari-accent">2 months free</div>
              </button>
            </div>

            {error && (
              <p className="text-xs text-red-400 text-center">{error}</p>
            )}

            <div className="text-center">
              <button
                onClick={onClose}
                className="text-xs text-zinc-500 hover:text-fg-base transition-colors"
              >
                Maybe later
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
