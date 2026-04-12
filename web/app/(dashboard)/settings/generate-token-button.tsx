"use client";

import { useState, useTransition } from "react";
import { Copy, Check, RefreshCw } from "lucide-react";
import { generateDesktopToken } from "./actions";

export function GenerateDesktopTokenButton() {
  const [token, setToken]       = useState<string | null>(null);
  const [copied, setCopied]     = useState(false);
  const [isPending, start]      = useTransition();

  const handleGenerate = () => {
    start(async () => {
      const res = await generateDesktopToken();
      if (res.token) setToken(res.token);
    });
  };

  const handleCopy = () => {
    if (!token) return;
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleGenerate}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-fg-base/60 hover:border-fg-base/30 hover:text-fg-base transition-all disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} aria-hidden="true" />
        {isPending ? "Generating…" : token ? "Regenerate token" : "Generate token"}
      </button>

      {token && (
        <div className="flex items-center gap-2 rounded-lg border border-line-medium bg-surface px-3 py-2">
          <p className="flex-1 font-mono text-[12px] text-fg-base break-all">{token}</p>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 text-fg-base/50 hover:text-fg-base transition-colors"
            aria-label="Copy token"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        </div>
      )}

      {token && (
        <p className="text-[11px] text-amber-600/80">
          Save this token — it won't be shown again after you leave this page.
        </p>
      )}
    </div>
  );
}
