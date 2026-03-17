"use client";

import { useState, useTransition } from "react";
import { Globe, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createStatusPage, deleteStatusPage, toggleStatusPage } from "./status-page-actions";

interface Props {
  projectId: string;
  isAdmin: boolean;
  statusPage: {
    id: string;
    slug: string;
    title: string;
    isPublic: boolean;
  } | null;
}

export function StatusPageSection({ projectId, isAdmin, statusPage }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [isPending, start] = useTransition();

  const handleCreate = () => {
    if (!title.trim() || !slug.trim()) return;
    start(async () => {
      await createStatusPage(projectId, title, slug);
      setShowForm(false);
      setTitle("");
      setSlug("");
    });
  };

  return (
    <section>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-500">
        Public Status Page
      </h2>
      <div className="rounded-xl border border-line bg-surface px-5 py-4">
        {statusPage ? (
          <div className="space-y-3">
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
                  {isPending ? "Creating…" : "Create Status Page"}
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
