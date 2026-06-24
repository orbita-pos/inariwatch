"use client";

import { useState, useEffect, useTransition } from "react";
import { Lightbulb, Loader2, Users, CheckCircle2, Wrench } from "lucide-react";
import { startRemediation } from "./remediation-actions";

interface CommunityFixData {
  fixApproach:       string;
  fixDescription:    string;
  filesChanged:      string[];
  successRate:       number;
  successCount:      number;
  totalApplications: number;
  occurrenceCount:   number;
  avgConfidence:     number;
}

function qualityLabel(rate: number): { text: string; cls: string } {
  if (rate >= 90) return { text: "High confidence",   cls: "text-emerald-600 dark:text-emerald-400" };
  if (rate >= 70) return { text: "Good confidence",   cls: "text-amber-600 dark:text-amber-400" };
  return               { text: "Mixed results",       cls: "text-fg-base" };
}

export function CommunityFixBanner({
  alertId,
  fingerprint,
}: {
  alertId:     string;
  fingerprint: string;
}) {
  const [fix, setFix]                   = useState<CommunityFixData | null>(null);
  const [loading, setLoading]           = useState(true);
  const [isPending, startTransition]    = useTransition();
  const [applied, setApplied]           = useState(false);
  const [error, setError]               = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/community-fix?fingerprint=${encodeURIComponent(fingerprint)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled) setFix(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fingerprint]);

  if (loading || !fix) return null;

  function handleApply() {
    setError(null);
    startTransition(async () => {
      const result = await startRemediation(alertId);
      if (result.error) {
        setError(result.error);
      } else {
        setApplied(true);
      }
    });
  }

  if (applied) {
    return (
      <section
        role="status"
        aria-live="polite"
        className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-5 py-4"
      >
        <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          Community fix applied — remediation started
        </div>
      </section>
    );
  }

  const quality = qualityLabel(fix.successRate);

  return (
    <section
      aria-labelledby="community-fix-heading"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-5 py-3 border-b border-amber-500/20">
        <Lightbulb className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <h2 id="community-fix-heading" className="text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
          Community Fix Available
        </h2>
      </div>

      <div className="px-5 py-4 space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          <div className="flex items-center gap-1.5 text-fg-base">
            <Users className="h-3.5 w-3.5 text-fg-base/60" aria-hidden="true" />
            <span>
              {fix.occurrenceCount} team{fix.occurrenceCount !== 1 ? "s" : ""} hit this error
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`font-mono font-bold ${quality.cls}`}>
              {fix.successRate}%
            </span>
            <span className={`text-xs font-medium ${quality.cls}`}>{quality.text}</span>
            <span className="text-xs text-fg-base/60">
              ({fix.successCount}/{fix.totalApplications})
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface-inner px-4 py-3 space-y-2">
          <p className="text-xs font-medium text-fg-base/70 uppercase tracking-wider">Fix approach</p>
          <p className="text-sm text-fg-strong leading-relaxed">{fix.fixApproach}</p>
          {fix.filesChanged.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {fix.filesChanged.map((f) => (
                <code
                  key={f}
                  className="text-xs font-mono text-fg-base bg-surface-dim border border-line-subtle px-1.5 py-0.5 rounded"
                >
                  {f}
                </code>
              ))}
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 font-mono">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleApply}
          disabled={isPending}
          aria-busy={isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-amber-950"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Wrench className="h-4 w-4" aria-hidden="true" />
          )}
          Apply Community Fix
        </button>
      </div>
    </section>
  );
}
