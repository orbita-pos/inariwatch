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
  const [open, setOpen] = useState(service === "capture" || service === "agent"); // auto-open for capture/agent
  const [copiedId, setCopiedId] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copiedDsn, setCopiedDsn] = useState(false);
  const [copiedToml, setCopiedToml] = useState(false);

  const webhookUrl = `${getAppUrl()}/api/webhooks/${service}/${integrationId}`;
  const dsnFull = service === "capture" ? `https://${webhookSecret}@${getAppUrl().replace(/^https?:\/\//, "")}/capture/${integrationId}` : null;
  const dsnMasked = service === "capture" ? `https://${webhookSecret.slice(0, 8)}${"•".repeat(20)}@${getAppUrl().replace(/^https?:\/\//, "")}/capture/${integrationId}` : null;

  function copy(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  }

  const setupHint: Record<string, string> = {
    github: "GitHub → Repo Settings → Webhooks → Add webhook. Set Content type to application/json. Select events: Check runs, Workflow runs, Pull requests.",
    vercel: "Vercel → Project Settings → Git → Deploy Hooks, or Vercel Integration → Webhooks. Select deployment events.",
    sentry: "Sentry → Settings → Developer Settings → Webhooks. Select Issue events.",
    expo: "Expo → Project Settings → Webhooks → Add webhook. Paste the URL below and set the secret. Select Build and Update events.",
    capture: "Copy the DSN above and add it to your .env as INARIWATCH_DSN. Then run: npx @inariwatch/mcp init",
    agent: "Copy the Integration ID and Secret into /etc/inariwatch/agent.toml under [cloud]. Then restart the agent: sudo systemctl restart inariwatch-agent",
  };

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface-inner overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-fg-base/60 hover:text-fg-base transition-colors"
      >
        <Webhook aria-hidden="true" className="h-3.5 w-3.5" />
        <span>{service === "capture" || service === "agent" ? "Setup" : "Webhook (real-time)"}</span>
        {open ? (
          <ChevronDown aria-hidden="true" className="ml-auto h-3.5 w-3.5" />
        ) : (
          <ChevronRight aria-hidden="true" className="ml-auto h-3.5 w-3.5" />
        )}
      </button>

      {open && (
        <div className="border-t border-line px-3 py-2.5 space-y-2.5">
          {/* DSN for Capture — secret masked in display, full value only on copy */}
          {dsnFull && dsnMasked && (
            <div>
              <p className="text-xs text-fg-base/50 mb-1">DSN <span className="text-fg-base/40">(click copy, then add to .env as INARIWATCH_DSN)</span></p>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2 py-1 text-xs text-orange-600 dark:text-orange-400 font-mono">
                  {dsnMasked}
                </code>
                <button
                  type="button"
                  onClick={() => copy(dsnFull, setCopiedDsn)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-base/50 hover:text-fg-base hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                  title="Copy full DSN to clipboard"
                >
                  {copiedDsn ? <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}
          {/* Agent TOML config */}
          {service === "agent" && (
            <>
              <div>
                <p className="text-xs text-fg-base/50 mb-1">Integration ID</p>
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400 font-mono">
                    {integrationId}
                  </code>
                  <button
                    type="button"
                    onClick={() => copy(integrationId, setCopiedId)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-base/50 hover:text-fg-base hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                    title="Copy Integration ID"
                  >
                    {copiedId ? <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <div>
                <p className="text-xs text-fg-base/50 mb-1">agent.toml <span className="text-fg-base/40">(/etc/inariwatch/agent.toml)</span></p>
                <div className="flex items-start gap-1.5">
                  <pre className="flex-1 rounded bg-surface-dim border border-line px-2 py-1.5 text-[11px] text-fg-base/60 font-mono whitespace-pre overflow-x-auto">{`[cloud]
endpoint = "${getAppUrl()}/api/agent/events"
integration_id = "${integrationId}"
webhook_secret = "<paste secret above>"`}</pre>
                  <button
                    type="button"
                    onClick={() => copy(`[cloud]\nendpoint = "${getAppUrl()}/api/agent/events"\nintegration_id = "${integrationId}"\nwebhook_secret = "${webhookSecret}"`, setCopiedToml)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-base/50 hover:text-fg-base hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors mt-0.5"
                    title="Copy TOML config (with real secret)"
                  >
                    {copiedToml ? <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            </>
          )}
          {/* URL */}
          <div>
            <p className="text-xs text-fg-base/50 mb-1">Webhook URL</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2 py-1 text-xs text-fg-base/60 font-mono">
                {webhookUrl}
              </code>
              <button
                type="button"
                onClick={() => copy(webhookUrl, setCopiedUrl)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-base/50 hover:text-fg-base hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                title="Copy URL"
              >
                {copiedUrl ? <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Secret */}
          <div>
            <p className="text-xs text-fg-base/50 mb-1">Secret</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2 py-1 text-xs text-fg-base/60 font-mono">
                {webhookSecret.slice(0, 8)}{"•".repeat(24)}
              </code>
              <button
                type="button"
                onClick={() => copy(webhookSecret, setCopiedSecret)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-base/50 hover:text-fg-base hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                title="Copy secret"
              >
                {copiedSecret ? <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Setup hint */}
          <p className="text-xs text-fg-base/50 leading-relaxed">
            {setupHint[service] ?? "Configure this webhook URL in your service settings."}
          </p>
        </div>
      )}
    </div>
  );
}
