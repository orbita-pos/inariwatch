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

  // ── Beta: all users have Pro features ───────────────────────────────────────
  return (
    <div className="rounded-xl border border-line bg-surface-dim overflow-hidden">
      <div className="px-5 py-4 border-b border-line">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-fg-strong">Beta Plan</h3>
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
            All Pro features included
          </span>
        </div>
        <p className="text-xs text-fg-base/60 mt-0.5">
          You have full access to all Pro features during beta at no cost.
        </p>
      </div>

      <div className="px-5 py-4">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.04] p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="h-5 w-5 text-emerald-500" aria-hidden="true" />
            <h4 className="text-sm font-semibold text-fg-strong">What you get during beta</h4>
          </div>
          <ul className="space-y-1 text-sm text-fg-base">
            <li>• 3,000 auto-analyses/month</li>
            <li>• 25 AI remediations/month</li>
            <li>• 500 chat messages/month</li>
            <li>• 30 PR predictions, 50 postmortems</li>
            <li>• All AI features — no API key required</li>
          </ul>
        </div>

        <div className="rounded-lg border border-line bg-surface-inner p-3">
          <p className="text-xs text-fg-base/60 text-center">
            After beta, Pro will be <span className="font-semibold text-fg-base">$12/month</span> or{" "}
            <span className="font-semibold text-fg-base">$120/year</span>. Early beta users will get a special rate.
          </p>
        </div>
      </div>
    </div>
  );
}
