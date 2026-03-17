"use client";

import { useState } from "react";
import { Webhook, Copy, Check, ChevronDown, ChevronRight } from "lucide-react";

function getAppUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL ?? "https://inariwatch.com";
}

export function WebhookInfo({
  integrationId,
  service,
  webhookSecret,
}: {
  integrationId: string;
  service: string;
  webhookSecret: string;
}) {
  const [open, setOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const webhookUrl = `${getAppUrl()}/api/webhooks/${service}/${integrationId}`;

  function copy(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  }

  const setupHint: Record<string, string> = {
    github: "GitHub → Repo Settings → Webhooks → Add webhook. Set Content type to application/json. Select events: Check runs, Workflow runs, Pull requests.",
    vercel: "Vercel → Project Settings → Git → Deploy Hooks, or Vercel Integration → Webhooks. Select deployment events.",
    sentry: "Sentry → Settings → Developer Settings → Webhooks. Select Issue events.",
  };

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface-inner overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:text-fg-base transition-colors"
      >
        <Webhook className="h-3.5 w-3.5" />
        <span>Webhook (real-time)</span>
        {open ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="ml-auto h-3.5 w-3.5" />
        )}
      </button>

      {open && (
        <div className="border-t border-line px-3 py-2.5 space-y-2.5">
          {/* URL */}
          <div>
            <p className="text-xs text-zinc-600 mb-1">Webhook URL</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2 py-1 text-xs text-zinc-400 font-mono">
                {webhookUrl}
              </code>
              <button
                type="button"
                onClick={() => copy(webhookUrl, setCopiedUrl)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-600 hover:text-fg-base hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                title="Copy URL"
              >
                {copiedUrl ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Secret */}
          <div>
            <p className="text-xs text-zinc-600 mb-1">Secret</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2 py-1 text-xs text-zinc-400 font-mono">
                {webhookSecret.slice(0, 8)}{"•".repeat(24)}
              </code>
              <button
                type="button"
                onClick={() => copy(webhookSecret, setCopiedSecret)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-600 hover:text-fg-base hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                title="Copy secret"
              >
                {copiedSecret ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Setup hint */}
          <p className="text-xs text-zinc-600 leading-relaxed">
            {setupHint[service] ?? "Configure this webhook URL in your service settings."}
          </p>
        </div>
      )}
    </div>
  );
}
