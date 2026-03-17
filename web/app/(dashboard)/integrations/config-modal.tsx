"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition } from "react";
import { X, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveAlertConfig } from "./actions";

// ── Per-service alert types ────────────────────────────────────────────────────

const SERVICE_ALERTS: Record<
  string,
  {
    key: string;
    label: string;
    description: string;
    threshold?: { key: string; label: string; defaultValue: number; unit: string };
  }[]
> = {
  github: [
    {
      key: "failed_ci",
      label: "Failed CI",
      description: "Alert when CI checks fail on the default branch",
    },
    {
      key: "stale_pr",
      label: "Stale PRs",
      description: "Alert when open PRs have had no activity",
      threshold: { key: "days", label: "Days without activity", defaultValue: 3, unit: "days" },
    },
    {
      key: "unreviewed_pr",
      label: "Unreviewed PRs",
      description: "Alert when PRs with requested reviewers remain unreviewed",
      threshold: { key: "hours", label: "Hours waiting for review", defaultValue: 24, unit: "hrs" },
    },
    {
      key: "pr_risk_assessment",
      label: "Pre-deploy risk assessment",
      description: "AI analyzes PR diffs against incident history and comments on the PR",
    },
  ],
  vercel: [
    {
      key: "failed_production",
      label: "Failed production deploys",
      description: "Alert when a production deployment fails (critical)",
    },
    {
      key: "failed_preview",
      label: "Failed preview deploys",
      description: "Alert when a preview deployment fails (warning)",
    },
  ],
  sentry: [
    {
      key: "new_issues",
      label: "New issues",
      description: "Alert when a new issue is detected in Sentry",
    },
    {
      key: "regressions",
      label: "Regressions",
      description: "Alert when a previously resolved issue reappears (critical)",
    },
  ],
  uptime: [
    {
      key: "downtime",
      label: "Downtime",
      description: "Alert when an endpoint returns an unexpected status code or is unreachable",
    },
    {
      key: "slow_response",
      label: "Slow response",
      description: "Alert when an endpoint response time exceeds the threshold",
      threshold: { key: "thresholdMs", label: "Threshold", defaultValue: 5000, unit: "ms" },
    },
  ],
  postgres: [
    {
      key: "connection_failed",
      label: "Connection failed",
      description: "Alert when the database is unreachable",
    },
    {
      key: "high_connections",
      label: "High connections",
      description: "Alert when connection usage exceeds the threshold",
      threshold: { key: "thresholdPercent", label: "Threshold", defaultValue: 80, unit: "%" },
    },
    {
      key: "long_queries",
      label: "Long-running queries",
      description: "Alert when queries exceed the duration threshold",
      threshold: { key: "thresholdSec", label: "Threshold", defaultValue: 30, unit: "sec" },
    },
  ],
  npm: [
    {
      key: "critical_cves",
      label: "Critical CVEs",
      description: "Alert on critical-severity vulnerabilities in your dependencies",
    },
    {
      key: "high_cves",
      label: "High CVEs",
      description: "Alert on high-severity vulnerabilities in your dependencies",
    },
  ],
};

// ── Default enabled state ─────────────────────────────────────────────────────

const DEFAULT_ENABLED: Record<string, Record<string, boolean>> = {
  github:  { failed_ci: true, stale_pr: true, unreviewed_pr: true, pr_risk_assessment: true },
  vercel:  { failed_production: true, failed_preview: false },
  sentry:  { new_issues: true, regressions: true },
  uptime:   { downtime: true, slow_response: true },
  postgres: { connection_failed: true, high_connections: true, long_queries: true },
  npm:      { critical_cves: true, high_cves: true },
};

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  integrationId: string;
  service: string;
  currentConfig: Record<string, unknown>;
  children: React.ReactNode;
}

export function ConfigModal({ integrationId, service, currentConfig, children }: Props) {
  const alertTypes = SERVICE_ALERTS[service] ?? [];
  const defaults   = DEFAULT_ENABLED[service] ?? {};

  // Build initial state from currentConfig.alertConfig or defaults
  const saved = (currentConfig.alertConfig ?? {}) as Record<string, Record<string, unknown>>;

  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      alertTypes.map(({ key }) => [
        key,
        saved[key]?.enabled !== undefined ? !!saved[key].enabled : (defaults[key] ?? true),
      ])
    )
  );

  const [thresholds, setThresholds] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      alertTypes
        .filter((t) => t.threshold)
        .map(({ key, threshold }) => [
          key,
          (saved[key]?.[threshold!.key] as number) ?? threshold!.defaultValue,
        ])
    )
  );

  const [open, setOpen]    = useState(false);
  const [isPending, start] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const alertConfig: Record<string, Record<string, unknown>> = {};
    for (const type of alertTypes) {
      alertConfig[type.key] = { enabled: enabled[type.key] };
      if (type.threshold) {
        alertConfig[type.key][type.threshold.key] = thresholds[type.key] ?? type.threshold.defaultValue;
      }
    }

    start(async () => {
      await saveAlertConfig(integrationId, alertConfig);
      setOpen(false);
    });
  };

  if (alertTypes.length === 0) return <>{children}</>;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />

        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#222] bg-[#0d0d0d] shadow-[0_0_60px_rgba(0,0,0,0.7)] focus:outline-none">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#1a1a1a] px-5 py-4">
            <Dialog.Title className="text-sm font-semibold text-white capitalize">
              Configure {service} alerts
            </Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-zinc-600 hover:text-zinc-300 transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="space-y-3 px-5 py-5">
              {alertTypes.map((type) => (
                <div
                  key={type.key}
                  className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-200">{type.label}</p>
                      <p className="mt-0.5 text-[12px] text-zinc-600">{type.description}</p>
                    </div>

                    {/* Toggle */}
                    <button
                      type="button"
                      onClick={() => setEnabled((prev) => ({ ...prev, [type.key]: !prev[type.key] }))}
                      className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
                        enabled[type.key] ? "bg-inari-accent" : "bg-zinc-800"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                          enabled[type.key] ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Threshold input */}
                  {type.threshold && enabled[type.key] && (
                    <div className="mt-3 flex items-center gap-3">
                      <label className="text-[11px] text-zinc-600 flex-1">{type.threshold.label}</label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={thresholds[type.key] ?? type.threshold.defaultValue}
                          onChange={(e) =>
                            setThresholds((prev) => ({
                              ...prev,
                              [type.key]: Number(e.target.value),
                            }))
                          }
                          className="w-16 rounded-lg border border-[#222] bg-[#111] px-2 py-1 text-center text-sm text-zinc-100 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20"
                        />
                        <span className="text-[11px] text-zinc-600">{type.threshold.unit}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-2 border-t border-[#1a1a1a] px-5 py-4">
              <Dialog.Close asChild>
                <Button variant="outline" className="flex-1" type="button">Cancel</Button>
              </Dialog.Close>
              <Button variant="primary" className="flex-1" type="submit" disabled={isPending}>
                {isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
