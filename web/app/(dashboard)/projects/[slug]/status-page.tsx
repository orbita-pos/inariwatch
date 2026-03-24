"use client";

import { useState, useTransition } from "react";
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
  { value: "error", label: "Error and above" },
  { value: "warning", label: "Warning and above" },
] as const;

export function StatusPageSection({ projectId, isAdmin, statusPage }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [isPending, start] = useTransition();

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
    <section>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-500">
        Public Status Page
      </h2>
      <div className="rounded-xl border border-line bg-surface px-5 py-4">
        {statusPage ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Globe className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-sm font-medium text-zinc-300">{statusPage.title}</p>
                  <p className="text-xs font-mono text-zinc-600">/status/{statusPage.slug}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`/status/${statusPage.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-300 transition-colors"
                  title="Open status page"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        start(async () => {
                          await deleteStatusPage(statusPage.id);
                        })
                      }
                      disabled={isPending}
                      className="text-red-400 hover:text-red-300"
                    >
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </div>
            <p className="text-xs text-zinc-600">
              {statusPage.isPublic
                ? "This page is publicly accessible."
                : "This page is private (not visible to the public)."}
            </p>

            {/* Automation config */}
            {isAdmin && (
              <div className="border-t border-line pt-3 space-y-3">
                <p className="text-xs font-medium text-zinc-400">Automation</p>

                <label className="flex items-center justify-between">
                  <div>
                    <span className="text-sm text-zinc-300">Auto-create incidents</span>
                    <p className="text-xs text-zinc-600">Automatically post incidents when qualifying alerts arrive</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!config.autoCreateIncident}
                    onClick={() => toggleConfig("autoCreateIncident")}
                    disabled={isPending}
                    className={`relative h-5 w-9 rounded-full transition-colors ${
                      config.autoCreateIncident ? "bg-green-500" : "bg-zinc-700"
                    }`}
                  >
                    <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      config.autoCreateIncident ? "translate-x-4" : ""
                    }`} />
                  </button>
                </label>

                <label className="flex items-center justify-between">
                  <div>
                    <span className="text-sm text-zinc-300">Auto-resolve</span>
                    <p className="text-xs text-zinc-600">Resolve incidents when the fix passes post-merge monitoring</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!config.autoResolve}
                    onClick={() => toggleConfig("autoResolve")}
                    disabled={isPending}
                    className={`relative h-5 w-9 rounded-full transition-colors ${
                      config.autoResolve ? "bg-green-500" : "bg-zinc-700"
                    }`}
                  >
                    <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      config.autoResolve ? "translate-x-4" : ""
                    }`} />
                  </button>
                </label>

                <label className="flex items-center justify-between">
                  <div>
                    <span className="text-sm text-zinc-300">Notify subscribers</span>
                    <p className="text-xs text-zinc-600">Email subscribers on incident creation and resolution</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!config.notifySubscribers}
                    onClick={() => toggleConfig("notifySubscribers")}
                    disabled={isPending}
                    className={`relative h-5 w-9 rounded-full transition-colors ${
                      config.notifySubscribers ? "bg-green-500" : "bg-zinc-700"
                    }`}
                  >
                    <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      config.notifySubscribers ? "translate-x-4" : ""
                    }`} />
                  </button>
                </label>

                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm text-zinc-300">Minimum severity</span>
                    <p className="text-xs text-zinc-600">Only create incidents for alerts at or above this level</p>
                  </div>
                  <select
                    value={config.minSeverityToPost ?? "critical"}
                    onChange={(e) => setSeverity(e.target.value)}
                    disabled={isPending}
                    className="rounded-lg border border-line-medium bg-surface-dim px-2 py-1 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none"
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
                <label className="text-xs text-zinc-500">Page title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="My App Status"
                  className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder-zinc-400 focus:border-inari-accent/40 focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">URL slug</label>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-zinc-600 font-mono">/status/</span>
                  <input
                    type="text"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    placeholder="my-app"
                    className="flex-1 rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base font-mono placeholder-zinc-400 focus:border-inari-accent/40 focus:outline-none"
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
                >
                  {isPending ? "Creating..." : "Create Status Page"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-center py-2">
              <p className="text-sm text-zinc-500 mb-3">
                Share a public status page with your users.
              </p>
              <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
                Create Status Page
              </Button>
            </div>
          )
        ) : (
          <p className="text-sm text-zinc-500 text-center py-2">No status page configured.</p>
        )}
      </div>
    </section>
  );
}
