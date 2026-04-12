"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Sparkles, ArrowRight, ExternalLink, CreditCard, Calendar, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BillingInfo {
  plan: "free" | "pro";
  status: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasStripeCustomer: boolean;
}

export function BillingSection({ billing }: { billing: BillingInfo }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async (interval: "monthly" | "annual") => {
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

  const handleManage = async () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/billing/portal", { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Failed to open portal");
          return;
        }
        if (data.url) window.location.href = data.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      }
    });
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  };

  // ── Pro user: show subscription details ────────────────────────────────────
  if (billing.plan === "pro") {
    const isPastDue = billing.status === "past_due";
    const isCanceling = billing.cancelAtPeriodEnd;

    return (
      <div className="rounded-xl border border-line bg-surface-dim overflow-hidden">
        <div className="px-5 py-4 border-b border-line bg-inari-accent/5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-inari-accent" aria-hidden="true" />
            <h3 className="text-base font-semibold text-fg-strong">Pro Plan</h3>
            <span className="ml-auto text-xs font-mono text-inari-accent uppercase tracking-wider">
              Active
            </span>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          {isPastDue && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="text-sm">
                <p className="text-red-600 dark:text-red-400 font-medium">Payment failed</p>
                <p className="text-xs text-fg-base/60 mt-0.5">
                  Update your card to continue Pro access.
                </p>
              </div>
            </div>
          )}

          {isCanceling && billing.periodEnd && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <Calendar className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="text-sm">
                <p className="text-amber-600 dark:text-amber-400 font-medium">Cancellation scheduled</p>
                <p className="text-xs text-fg-base/60 mt-0.5">
                  Your Pro access ends on {formatDate(billing.periodEnd)}. You can resume anytime.
                </p>
              </div>
            </div>
          )}

          {billing.periodEnd && !isCanceling && (
            <div className="flex items-center gap-2 text-sm text-fg-base/60">
              <Calendar className="h-4 w-4" aria-hidden="true" />
              <span>Renews {formatDate(billing.periodEnd)}</span>
            </div>
          )}

          <div className="pt-2">
            <Button
              variant="outline"
              onClick={handleManage}
              disabled={isPending}
              className="w-full border-inari-border text-fg-base hover:text-fg-strong hover:border-line"
            >
              {isPending ? "Opening..." : (
                <>
                  <CreditCard className="mr-2 h-4 w-4" aria-hidden="true" />
                  Manage subscription
                  <ExternalLink className="ml-2 h-3 w-3" aria-hidden="true" />
                </>
              )}
            </Button>
            <p className="mt-2 text-xs text-fg-base/60 text-center">
              Update card, view invoices, cancel — all in Stripe&apos;s secure portal.
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>
          )}
        </div>
      </div>
    );
  }

  // ── Free user: show upgrade CTA ────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-line bg-surface-dim overflow-hidden">
      <div className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg-strong">Free Plan</h3>
        <p className="text-xs text-fg-base/60 mt-0.5">
          Generous free tier for indie devs. Upgrade for 10x more AI usage.
        </p>
      </div>

      <div className="px-5 py-4">
        <div className="rounded-lg border border-inari-accent/30 bg-inari-accent/5 p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="h-5 w-5 text-inari-accent" aria-hidden="true" />
            <h4 className="text-sm font-semibold text-fg-strong">Upgrade to Pro</h4>
          </div>
          <ul className="space-y-1 text-sm text-fg-base mb-4">
            <li>• 3,000 auto-analyses (10x more)</li>
            <li>• 25 AI remediations (8x more)</li>
            <li>• 500 chat messages (5x more)</li>
            <li>• 30 PR predictions, 50 postmortems</li>
            <li>• Email support</li>
          </ul>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => handleUpgrade("monthly")}
              disabled={isPending}
              className="rounded-md border border-inari-accent/40 bg-transparent px-3 py-2 text-xs hover:bg-inari-accent/10 transition-colors disabled:opacity-50"
            >
              <div className="font-semibold text-fg-strong">$12/mo</div>
              <div className="text-fg-base/60 mt-0.5">Monthly</div>
            </button>
            <button
              onClick={() => handleUpgrade("annual")}
              disabled={isPending}
              className="rounded-md border-2 border-inari-accent bg-inari-accent/10 px-3 py-2 text-xs hover:bg-inari-accent/20 transition-colors disabled:opacity-50 relative"
            >
              <span className="absolute -top-2 right-1 bg-inari-accent text-bg-base text-[9px] font-mono font-bold px-1.5 py-0.5 rounded uppercase">
                Save $24
              </span>
              <div className="font-semibold text-fg-strong">$120/yr</div>
              <div className="text-inari-accent mt-0.5">2 months free</div>
            </button>
          </div>
        </div>

        <Link
          href="/pricing"
          className="flex items-center justify-center gap-1 text-xs text-fg-base/60 hover:text-fg-base transition-colors"
        >
          See full pricing details <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>

        {error && (
          <p className="mt-3 text-xs text-red-600 dark:text-red-400 text-center" role="alert">{error}</p>
        )}
      </div>
    </div>
  );
}
