"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createWebhook, deleteWebhook } from "./webhook-actions";

interface Webhook {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: Date;
}

const EVENT_OPTIONS = [
  { value: "alert.created", label: "Alert created" },
  { value: "alert.resolved", label: "Alert resolved" },
];

export function WebhookSection({ webhooks }: { webhooks: Webhook[] }) {
  const [showForm, setShowForm] = useState(false);
  const [isPending, start] = useTransition();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["alert.created"]);

  const handleCreate = () => {
    if (!url.trim()) return;
    start(async () => {
      await createWebhook(url, events);
      setUrl("");
      setEvents(["alert.created"]);
      setShowForm(false);
    });
  };

  const handleDelete = (id: string) => {
    start(async () => {
      await deleteWebhook(id);
    });
  };

  return (
    <div className="space-y-3 py-1">
      {webhooks.length === 0 && !showForm ? (
        <div className="py-4 text-center">
          <p className="text-sm text-zinc-500">No outgoing webhooks configured.</p>
          <p className="mt-1 text-sm text-zinc-600">
            Webhooks send HMAC-signed POST requests when events occur.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-line-subtle">
          {webhooks.map((wh) => (
            <div key={wh.id} className="flex items-center gap-3 py-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-surface-dim text-zinc-500">
                <Globe className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-fg-base font-mono truncate">{wh.url}</p>
                <p className="text-xs text-zinc-600">
                  {wh.events.join(", ")} &middot; {wh.isActive ? "Active" : "Inactive"}
                </p>
              </div>
              <button
                onClick={() => handleDelete(wh.id)}
                disabled={isPending}
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors"
                title="Delete webhook"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="space-y-3 rounded-lg border border-line bg-surface-inner p-4">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Endpoint URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base font-mono placeholder-zinc-400 focus:border-inari-accent/40 focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Events</label>
            <div className="flex flex-wrap gap-2">
              {EVENT_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={events.includes(opt.value)}
                    onChange={(e) => {
                      if (e.target.checked) setEvents([...events, opt.value]);
                      else setEvents(events.filter((ev) => ev !== opt.value));
                    }}
                    className="rounded border-zinc-700"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleCreate} disabled={isPending || !url.trim()}>
              {isPending ? "Creating…" : "Create"}
            </Button>
          </div>
        </div>
      )}

      <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="gap-1.5">
        <Plus className="h-3.5 w-3.5" /> Add webhook
      </Button>
    </div>
  );
}
