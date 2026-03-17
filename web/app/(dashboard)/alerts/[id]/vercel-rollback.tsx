"use client";

import { useState, useTransition } from "react";
import { RotateCcw, Loader2, CheckCircle2, ExternalLink } from "lucide-react";
import { rollbackVercelDeploy } from "./rollback-actions";

export function VercelRollbackPanel({
  alertId,
  isResolved,
}: {
  alertId: string;
  isResolved: boolean;
}) {
  const [isPending, start] = useTransition();
  const [result, setResult] = useState<{ url?: string; error?: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  function handleRollback() {
    if (!confirmed) {
      setConfirmed(true);
      return;
    }
    start(async () => {
      const res = await rollbackVercelDeploy(alertId);
      setResult(res);
      setConfirmed(false);
    });
  }

  if (isResolved && !result) return null;

  // Already rolled back
  if (result?.url) {
    return (
      <section className="rounded-xl border border-emerald-900/30 bg-emerald-950/10 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-emerald-900/20">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <span className="text-xs font-medium uppercase tracking-wider text-emerald-400">Rollback Complete</span>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-emerald-400 font-medium mb-1">
            Successfully rolled back to the last successful deployment.
          </p>
          {result.url && (
            <a
              href={result.url.startsWith("http") ? result.url : `https://${result.url}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-emerald-500/70 hover:text-emerald-400 underline underline-offset-2"
            >
              View deployment
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-orange-900/30 bg-orange-950/10 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-orange-900/20">
        <RotateCcw className="h-4 w-4 text-orange-400" />
        <span className="text-xs font-medium uppercase tracking-wider text-orange-400">Quick Rollback</span>
      </div>
      <div className="px-5 py-4 space-y-3">
        <p className="text-sm text-zinc-400">
          Instantly rollback to the last successful production deployment. No code changes, no CI — takes seconds.
        </p>

        {result?.error && (
          <div className="rounded-lg border border-red-900/30 bg-red-950/20 px-4 py-3">
            <p className="text-sm text-red-400">{result.error}</p>
          </div>
        )}

        <button
          onClick={handleRollback}
          disabled={isPending}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
            confirmed
              ? "bg-orange-600 text-white hover:bg-orange-500"
              : "border border-orange-900/40 bg-orange-950/20 text-orange-400 hover:bg-orange-950/40 hover:border-orange-800/50"
          }`}
        >
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Rolling back…
            </>
          ) : confirmed ? (
            <>
              <RotateCcw className="h-4 w-4" />
              Confirm rollback
            </>
          ) : (
            <>
              <RotateCcw className="h-4 w-4" />
              Rollback to last successful deploy
            </>
          )}
        </button>
        {confirmed && !isPending && (
          <p className="text-xs text-orange-500/70">
            Click again to confirm. This will promote the last successful deploy to production.
          </p>
        )}
      </div>
    </section>
  );
}
