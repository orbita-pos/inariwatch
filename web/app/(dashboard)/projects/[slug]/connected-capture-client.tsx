"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Loader2, Terminal } from "lucide-react";
import { CaptureIcon } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import { enableCapture, disableCapture } from "./capture-actions";

interface Props {
  projectId: string;
  isAdmin: boolean;
  enabled: boolean;
  dsnFull: string | null;
  dsnMasked: string | null;
}

/**
 * Per-project Capture SDK panel — replaces the global /integrations card.
 *
 * Lives next to ConnectedRepoSection so a project's two real connections
 * (the repo it tracks + the SDK that streams runtime errors from it)
 * sit on the same screen.
 */
export function ConnectedCaptureClient({
  projectId,
  isAdmin,
  enabled,
  dsnFull,
  dsnMasked,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"dsn" | "install" | "wrap" | null>(null);

  function copy(value: string, key: "dsn" | "install" | "wrap") {
    navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1800);
  }

  function handleEnable() {
    setError(null);
    startTransition(async () => {
      const result = await enableCapture(projectId);
      if (!result.ok) setError(result.error);
    });
  }

  function handleDisable() {
    setError(null);
    if (!confirm("Disconnect Capture? Events from this project will stop flowing in.")) return;
    startTransition(async () => {
      const result = await disableCapture(projectId);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-dim shrink-0">
            <CaptureIcon aria-hidden="true" className="h-5 w-5 text-fg-base/70" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
              Capture SDK
            </p>
            <p className="text-sm text-fg-base/70">
              {enabled ? "Streaming runtime errors to this project." : "Not connected"}
            </p>
          </div>
        </div>

        {enabled ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-green-500/20 bg-green-500/[0.05] px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" /> Connected
          </span>
        ) : (
          isAdmin && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="shrink-0"
              onClick={handleEnable}
              disabled={isPending}
            >
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Enable Capture"}
            </Button>
          )
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[12px] text-red-600 dark:text-red-400 font-mono">
          {error}
        </p>
      )}

      {enabled && dsnFull && dsnMasked && (
        <div className="space-y-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50 mb-1.5">
              DSN <span className="ml-1 normal-case tracking-normal text-fg-base/40">paste into your hosting provider as INARIWATCH_DSN</span>
            </p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2.5 py-1.5 font-mono text-xs text-orange-600 dark:text-orange-400">
                {dsnMasked}
              </code>
              <button
                type="button"
                onClick={() => copy(dsnFull, "dsn")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base hover:border-line-medium"
                title="Copy full DSN"
              >
                {copied === "dsn" ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50 mb-1.5 flex items-center gap-1.5">
              <Terminal aria-hidden="true" className="h-3 w-3" /> Install
            </p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2.5 py-1.5 font-mono text-xs text-fg-base/70">
                npm install @inariwatch/capture
              </code>
              <button
                type="button"
                onClick={() => copy("npm install @inariwatch/capture", "install")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base hover:border-line-medium"
                title="Copy install command"
              >
                {copied === "install" ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50 mb-1.5">
              Next.js setup <span className="ml-1 normal-case tracking-normal text-fg-base/40">next.config.ts</span>
            </p>
            <div className="flex items-start gap-1.5">
              <pre className="flex-1 overflow-x-auto rounded bg-surface-dim border border-line px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-fg-base/70">{`import { withInariWatch } from "@inariwatch/capture/next"
export default withInariWatch(nextConfig)`}</pre>
              <button
                type="button"
                onClick={() => copy(`import { withInariWatch } from "@inariwatch/capture/next"\nexport default withInariWatch(nextConfig)`, "wrap")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base hover:border-line-medium"
                title="Copy snippet"
              >
                {copied === "wrap" ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <p className="text-[11px] text-fg-base/40">
            For non-Next runtimes use <code className="font-mono text-fg-base/60">node --import @inariwatch/capture/auto app.js</code>.
          </p>

          {isAdmin && (
            <div className="pt-1">
              <button
                type="button"
                onClick={handleDisable}
                disabled={isPending}
                className="text-[11px] text-fg-base/40 underline-offset-2 hover:underline hover:text-red-500/80 disabled:opacity-50"
              >
                Disconnect Capture
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
