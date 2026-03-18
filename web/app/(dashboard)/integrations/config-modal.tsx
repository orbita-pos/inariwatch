"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition, useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveAlertConfig, fetchIntegrationOptions } from "./actions";

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
    { key: "failed_ci",          label: "Failed CI",                  description: "Alert when CI checks fail on the default branch" },
    { key: "stale_pr",           label: "Stale PRs",                  description: "Alert when open PRs have had no activity", threshold: { key: "days", label: "Days without activity", defaultValue: 3, unit: "days" } },
    { key: "unreviewed_pr",      label: "Unreviewed PRs",             description: "Alert when PRs with requested reviewers remain unreviewed", threshold: { key: "hours", label: "Hours waiting for review", defaultValue: 24, unit: "hrs" } },
    { key: "pr_risk_assessment", label: "Pre-deploy risk assessment", description: "AI analyzes PR diffs against incident history and comments on the PR" },
  ],
  vercel: [
    { key: "failed_production", label: "Failed production deploys", description: "Alert when a production deployment fails (critical)" },
    { key: "failed_preview",    label: "Failed preview deploys",    description: "Alert when a preview deployment fails (warning)" },
  ],
  sentry: [
    { key: "new_issues",  label: "New issues",  description: "Alert when a new issue is detected in Sentry" },
    { key: "regressions", label: "Regressions", description: "Alert when a previously resolved issue reappears (critical)" },
  ],
  uptime: [
    { key: "downtime",      label: "Downtime",       description: "Alert when an endpoint returns an unexpected status code or is unreachable" },
    { key: "slow_response", label: "Slow response",  description: "Alert when an endpoint response time exceeds the threshold", threshold: { key: "thresholdMs", label: "Threshold", defaultValue: 5000, unit: "ms" } },
  ],
  postgres: [
    { key: "connection_failed", label: "Connection failed",       description: "Alert when the database is unreachable" },
    { key: "high_connections",  label: "High connections",        description: "Alert when connection usage exceeds the threshold", threshold: { key: "thresholdPercent", label: "Threshold", defaultValue: 80, unit: "%" } },
    { key: "long_queries",      label: "Long-running queries",    description: "Alert when queries exceed the duration threshold", threshold: { key: "thresholdSec", label: "Threshold", defaultValue: 30, unit: "sec" } },
  ],
  npm: [
    { key: "critical_cves", label: "Critical CVEs", description: "Alert on critical-severity vulnerabilities in your dependencies" },
    { key: "high_cves",     label: "High CVEs",     description: "Alert on high-severity vulnerabilities in your dependencies" },
  ],
};

const DEFAULT_ENABLED: Record<string, Record<string, boolean>> = {
  github:   { failed_ci: true, stale_pr: true, unreviewed_pr: true, pr_risk_assessment: true },
  vercel:   { failed_production: true, failed_preview: false },
  sentry:   { new_issues: true, regressions: true },
  uptime:   { downtime: true, slow_response: true },
  postgres: { connection_failed: true, high_connections: true, long_queries: true },
  npm:      { critical_cves: true, high_cves: true },
};

const HAS_FILTER = ["github", "vercel", "sentry"];

interface Props {
  integrationId: string;
  service: string;
  currentConfig: Record<string, unknown>;
  children: React.ReactNode;
}

export function ConfigModal({ integrationId, service, currentConfig, children }: Props) {
  const alertTypes = SERVICE_ALERTS[service] ?? [];
  const defaults   = DEFAULT_ENABLED[service] ?? {};
  const hasFilter  = HAS_FILTER.includes(service);

  const saved = (currentConfig.alertConfig ?? {}) as Record<string, Record<string, unknown>>;

  const [tab, setTab]         = useState<"alerts" | "filter">("alerts");
  const [open, setOpen]       = useState(false);
  const [isPending, start]    = useTransition();

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

  // Filter state
  const savedFilter = (currentConfig.alertConfig as Record<string, unknown> | undefined);
  const [filterOptions,   setFilterOptions]   = useState<{ label: string; value: string }[]>([]);
  const [selectedFilter,  setSelectedFilter]  = useState<string[]>(() => {
    if (!savedFilter) return [];
    const key = service === "github" ? "repoFilter" : service === "vercel" ? "projectFilter" : "sentryProjectFilter";
    return (savedFilter[key] as string[] | undefined) ?? [];
  });
  const [loadingOptions, setLoadingOptions] = useState(false);

  useEffect(() => {
    if (!open || !hasFilter) return;
    setLoadingOptions(true);
    fetchIntegrationOptions(integrationId).then((opts) => {
      setFilterOptions(opts);
      setLoadingOptions(false);
    });
  }, [open, integrationId, hasFilter]);

  // Reset tab when modal closes
  useEffect(() => { if (!open) setTab("alerts"); }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const alertConfig: Record<string, unknown> = {};
    for (const type of alertTypes) {
      alertConfig[type.key] = { enabled: enabled[type.key] } as Record<string, unknown>;
      if (type.threshold) {
        (alertConfig[type.key] as Record<string, unknown>)[type.threshold.key] =
          thresholds[type.key] ?? type.threshold.defaultValue;
      }
    }
    if (service === "github"  && selectedFilter.length > 0) alertConfig.repoFilter          = selectedFilter;
    if (service === "vercel"  && selectedFilter.length > 0) alertConfig.projectFilter        = selectedFilter;
    if (service === "sentry"  && selectedFilter.length > 0) alertConfig.sentryProjectFilter  = selectedFilter;

    start(async () => {
      await saveAlertConfig(integrationId, alertConfig);
      setOpen(false);
    });
  };

  if (alertTypes.length === 0) return <>{children}</>;

  const filterLabel = service === "github" ? "Repositories" : "Projects";
  const filterCount = selectedFilter.length;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />

        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-medium bg-surface-dim shadow-[0_0_60px_rgba(0,0,0,0.7)] focus:outline-none">

          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-sm font-semibold text-fg-strong capitalize">
              Configure {service} alerts
            </Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-zinc-600 hover:text-fg-base transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Tabs — only shown for services with filter */}
          {hasFilter && (
            <div className="flex border-b border-line px-5">
              {(["alerts", "filter"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`relative py-2.5 pr-4 text-[13px] font-medium transition-colors ${
                    tab === t ? "text-fg-strong" : "text-zinc-500 hover:text-zinc-400"
                  }`}
                >
                  {t === "alerts" ? "Alerts" : filterLabel}
                  {t === "filter" && filterCount > 0 && (
                    <span className="ml-1.5 rounded-full bg-inari-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-inari-accent">
                      {filterCount}
                    </span>
                  )}
                  {tab === t && (
                    <span className="absolute bottom-0 left-0 right-4 h-px bg-inari-accent" />
                  )}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">

              {/* ── Alerts tab ── */}
              {tab === "alerts" && alertTypes.map((type) => (
                <div key={type.key} className="rounded-xl border border-line bg-surface px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-fg-base">{type.label}</p>
                      <p className="mt-0.5 text-[12px] text-zinc-600">{type.description}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEnabled((prev) => ({ ...prev, [type.key]: !prev[type.key] }))}
                      className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
                        enabled[type.key] ? "bg-inari-accent" : "bg-zinc-800"
                      }`}
                    >
                      <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                        enabled[type.key] ? "translate-x-4" : "translate-x-0"
                      }`} />
                    </button>
                  </div>
                  {type.threshold && enabled[type.key] && (
                    <div className="mt-3 flex items-center gap-3">
                      <label className="text-[11px] text-zinc-600 flex-1">{type.threshold.label}</label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={thresholds[type.key] ?? type.threshold.defaultValue}
                          onChange={(e) => setThresholds((prev) => ({ ...prev, [type.key]: Number(e.target.value) }))}
                          className="w-16 rounded-lg border border-line-medium bg-surface-dim px-2 py-1 text-center text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20"
                        />
                        <span className="text-[11px] text-zinc-600">{type.threshold.unit}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* ── Filter tab ── */}
              {tab === "filter" && (
                <div className="space-y-3">
                  <p className="text-[12px] text-zinc-500">
                    {filterCount === 0
                      ? `Monitoring all ${filterLabel.toLowerCase()}. Select specific ones to narrow down.`
                      : `Monitoring ${filterCount} ${filterLabel.toLowerCase()}. Uncheck to monitor all.`}
                  </p>

                  {loadingOptions ? (
                    <div className="space-y-2.5">
                      {[70, 55, 80, 60, 45].map((w, i) => (
                        <div key={i} className="flex items-center gap-2.5">
                          <div className="h-3.5 w-3.5 rounded bg-zinc-800 animate-pulse shrink-0" />
                          <div className="h-3 rounded bg-zinc-800 animate-pulse" style={{ width: `${w}%` }} />
                        </div>
                      ))}
                    </div>
                  ) : filterOptions.length > 0 ? (
                    <div className="space-y-1">
                      {filterOptions.map((opt) => (
                        <label key={opt.value} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 cursor-pointer hover:bg-surface transition-colors group">
                          <input
                            type="checkbox"
                            checked={selectedFilter.includes(opt.value)}
                            onChange={(e) =>
                              setSelectedFilter((prev) =>
                                e.target.checked ? [...prev, opt.value] : prev.filter((v) => v !== opt.value)
                              )
                            }
                            className="h-3.5 w-3.5 shrink-0 rounded accent-inari-accent"
                          />
                          <span className="text-[12px] text-zinc-400 group-hover:text-fg-base transition-colors truncate font-mono">
                            {opt.label}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[12px] text-zinc-600">No {filterLabel.toLowerCase()} found.</p>
                  )}

                  {filterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedFilter([])}
                      className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
                    >
                      Clear — monitor all {filterLabel.toLowerCase()}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-2 border-t border-line px-5 py-4">
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
