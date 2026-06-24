"use client";

import { useState, useTransition, useId } from "react";
import { Globe, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createStatusPage, deleteStatusPage, toggleStatusPage, updateStatusPageConfig } from "./status-page-actions";
import type { StatusPageConfig } from "@/lib/db/schema";

interface Props {
  projectId: string;
  isAdmin: boolean;
  statusPage: {
    id: string;
    slug: string;
    title: string;
    isPublic: boolean;
    config: StatusPageConfig | null;
  } | null;
}

const SEVERITY_OPTIONS = [
  { value: "critical", label: "Critical only" },
  { value: "error",    label: "Error and above" },
  { value: "warning",  label: "Warning and above" },
] as const;

export function StatusPageSection({ projectId, isAdmin, statusPage }: Props) {
  const [showForm, setShowForm]               = useState(false);
  const [title, setTitle]                     = useState("");
  const [slug, setSlug]                       = useState("");
  const [isPending, start]                    = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const uid        = useId();
  const titleId    = `${uid}-title`;
  const slugId     = `${uid}-slug`;
  const autoCreateId  = `${uid}-auto-create`;
  const autoResolveId = `${uid}-auto-resolve`;
  const notifySubId   = `${uid}-notify-sub`;
  const minSevId      = `${uid}-min-sev`;

  const config: StatusPageConfig = {
    autoCreateIncident: false,
    autoResolve: true,
    notifySubscribers: true,
    minSeverityToPost: "critical",
    ...(statusPage?.config ?? {}),
  };

  const handleCreate = () => {
    if (!title.trim() || !slug.trim()) return;
    start(async () => {
      await createStatusPage(projectId, title, slug);
      setShowForm(false);
      setTitle("");
      setSlug("");
    });
  };

  const toggleConfig = (key: keyof StatusPageConfig) => {
    if (!statusPage) return;
    start(async () => {
      await updateStatusPageConfig(statusPage.id, { [key]: !config[key] });
    });
  };

  const setSeverity = (value: string) => {
    if (!statusPage) return;
    start(async () => {
      await updateStatusPageConfig(statusPage.id, { minSeverityToPost: value as StatusPageConfig["minSeverityToPost"] });
    });
  };

  return (
    <section aria-labelledby="status-page-heading">
      <h2 id="status-page-heading" className="mb-3 text-xs font-medium uppercase tracking-widest text-fg-base/70">
        Public Status Page
      </h2>

      <div className="rounded-xl border border-line bg-surface px-5 py-4">
        {statusPage ? (
          <div className="space-y-4">
            {/* Header row */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <Globe className="h-4 w-4 text-fg-base/60 shrink-0" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-fg-strong">{statusPage.title}</p>
                  <p className="text-xs font-mono text-fg-base/70">/status/{statusPage.slug}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={`/status/${statusPage.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${statusPage.title} status page (opens in new tab)`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-fg-strong hover:bg-surface-inner transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
                {isAdmin && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        start(async () => {
                          await toggleStatusPage(statusPage.id, !statusPage.isPublic);
                        })
                      }
                      disabled={isPending}
                    >
                      {statusPage.isPublic ? "Make Private" : "Make Public"}
                    </Button>
                    {confirmingDelete ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirmingDelete(false)}
                          disabled={isPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setConfirmingDelete(false);
                            start(async () => { await deleteStatusPage(statusPage.id); });
                          }}
                          disabled={isPending}
                          aria-busy={isPending}
                          className="text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/5"
                        >
                          {isPending ? "Deleting…" : "Confirm delete"}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmingDelete(true)}
                        disabled={isPending}
                        className="text-red-600 dark:text-red-400"
                      >
                        Delete
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>

            <p className="text-xs text-fg-base/70">
              {statusPage.isPublic
                ? "This page is publicly accessible."
                : "This page is private (not visible to the public)."}
            </p>

            {/* Automation config */}
            {isAdmin && (
              <div className="border-t border-line pt-3 space-y-3">
                <p className="text-xs font-medium text-fg-base/70">Automation</p>

                {/* Auto-create incidents */}
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p id={autoCreateId} className="text-sm text-fg-strong">Auto-create incidents</p>
                    <p className="text-xs text-fg-base/70">Automatically post incidents when qualifying alerts arrive</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!config.autoCreateIncident}
                    aria-labelledby={autoCreateId}
                    onClick={() => toggleConfig("autoCreateIncident")}
                    disabled={isPending}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 ${
                      config.autoCreateIncident ? "bg-emerald-500" : "bg-zinc-200 dark:bg-zinc-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                        config.autoCreateIncident ? "translate-x-4" : ""
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                </div>

                {/* Auto-resolve */}
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p id={autoResolveId} className="text-sm text-fg-strong">Auto-resolve</p>
                    <p className="text-xs text-fg-base/70">Resolve incidents when the fix passes post-merge monitoring</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!config.autoResolve}
                    aria-labelledby={autoResolveId}
                    onClick={() => toggleConfig("autoResolve")}
                    disabled={isPending}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 ${
                      config.autoResolve ? "bg-emerald-500" : "bg-zinc-200 dark:bg-zinc-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                        config.autoResolve ? "translate-x-4" : ""
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                </div>

                {/* Notify subscribers */}
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p id={notifySubId} className="text-sm text-fg-strong">Notify subscribers</p>
                    <p className="text-xs text-fg-base/70">Email subscribers on incident creation and resolution</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!config.notifySubscribers}
                    aria-labelledby={notifySubId}
                    onClick={() => toggleConfig("notifySubscribers")}
                    disabled={isPending}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 ${
                      config.notifySubscribers ? "bg-emerald-500" : "bg-zinc-200 dark:bg-zinc-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                        config.notifySubscribers ? "translate-x-4" : ""
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                </div>

                {/* Minimum severity */}
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <label htmlFor={minSevId} className="text-sm text-fg-strong">Minimum severity</label>
                    <p className="text-xs text-fg-base/70">Only create incidents for alerts at or above this level</p>
                  </div>
                  <select
                    id={minSevId}
                    value={config.minSeverityToPost ?? "critical"}
                    onChange={(e) => setSeverity(e.target.value)}
                    disabled={isPending}
                    className="rounded-lg border border-line-medium bg-surface-dim px-2 py-1 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-60"
                  >
                    {SEVERITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

        ) : isAdmin ? (
          showForm ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor={titleId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                  Page title
                </label>
                <input
                  id={titleId}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="My App Status"
                  className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor={slugId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                  URL slug
                </label>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-fg-base/60 font-mono">/status/</span>
                  <input
                    id={slugId}
                    type="text"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    placeholder="my-app"
                    className="flex-1 rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base font-mono placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCreate}
                  disabled={isPending || !title.trim() || !slug.trim()}
                  aria-busy={isPending}
                >
                  {isPending ? "Creating…" : "Create Status Page"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-center py-2">
              <p className="text-sm text-fg-base/70 mb-3">
                Share a public status page with your users.
              </p>
              <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
                Create Status Page
              </Button>
            </div>
          )
        ) : (
          <p className="text-sm text-fg-base/70 text-center py-2">No status page configured.</p>
        )}
      </div>
    </section>
  );
}
