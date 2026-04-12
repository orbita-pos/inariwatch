"use client";

import { useState, useTransition } from "react";
import { RotateCcw, Loader2, CheckCircle2, ExternalLink, X } from "lucide-react";
import { rollbackDeploy } from "./rollback-actions";

export function VercelRollbackPanel({
  alertId,
  isResolved,
}: {
  alertId:    string;
  isResolved: boolean;
}) {
  const [isPending, start]      = useTransition();
  const [result, setResult]     = useState<{ url?: string; provider?: string; error?: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  function handleRollback() {
    if (!confirmed) {
      setConfirmed(true);
      return;
    }
    start(async () => {
      const res = await rollbackDeploy(alertId);
      setResult(res);
      setConfirmed(false);
    });
  }

  if (isResolved && !result) return null;

  // Already rolled back
  if (result?.url) {
    const providerLabel = result.provider ? ` on ${result.provider}` : "";
    return (
      <section
        role="status"
        aria-live="polite"
        aria-labelledby="rollback-complete-heading"
        className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 overflow-hidden"
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-emerald-500/20">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <h2
            id="rollback-complete-heading"
            className="text-xs font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300"
          >
            Rollback Complete
          </h2>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-emerald-700 dark:text-emerald-400 font-medium mb-1">
            Successfully rolled back to the last successful deployment{providerLabel}.
          </p>
          {result.url && (
            <a
              href={result.url.startsWith("http") ? result.url : `https://${result.url}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 rounded-sm"
            >
              View deployment
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">(opens in new tab)</span>
            </a>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="rollback-heading"
      className="rounded-xl border border-orange-500/30 bg-orange-500/5 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-5 py-3 border-b border-orange-500/20">
        <RotateCcw className="h-4 w-4 text-orange-600 dark:text-orange-400" aria-hidden="true" />
        <h2 id="rollback-heading" className="text-xs font-medium uppercase tracking-wider text-orange-700 dark:text-orange-300">
          Quick Rollback
        </h2>
      </div>
      <div className="px-5 py-4 space-y-3">
        <p className="text-sm text-fg-base">
          Instantly rollback to the last successful production deployment. No code changes, no CI — takes seconds.
        </p>

        {result?.error && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3"
          >
            <p className="text-sm text-red-700 dark:text-red-400">{result.error}</p>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleRollback}
            disabled={isPending}
            aria-busy={isPending}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/50 ${
              confirmed
                ? "bg-orange-600 text-white hover:bg-orange-500 dark:bg-orange-500 dark:hover:bg-orange-400 dark:text-orange-950"
                : "border border-orange-500/40 bg-orange-500/5 text-orange-700 dark:text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/60"
            }`}
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Rolling back…
              </>
            ) : confirmed ? (
              <>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Confirm rollback
              </>
            ) : (
              <>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Rollback to last successful deploy
              </>
            )}
          </button>

          {confirmed && !isPending && (
            <button
              type="button"
              onClick={() => setConfirmed(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-2 text-sm font-medium text-fg-base hover:text-fg-strong hover:border-line transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
              aria-label="Cancel rollback"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Cancel
            </button>
          )}
        </div>

        {confirmed && !isPending && (
          <p
            role="status"
            aria-live="polite"
            className="text-xs text-orange-700 dark:text-orange-400"
          >
            Click &ldquo;Confirm rollback&rdquo; to promote the last successful deploy to production.
          </p>
        )}
      </div>
    </section>
  );
}
