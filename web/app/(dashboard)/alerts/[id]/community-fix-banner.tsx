"use client";

import { useState, useEffect, useTransition } from "react";
import { Lightbulb, Loader2, Users, CheckCircle2, Wrench } from "lucide-react";
import { startRemediation } from "./remediation-actions";

interface CommunityFixData {
  fixApproach: string;
  fixDescription: string;
  filesChanged: string[];
  successRate: number;
  successCount: number;
  totalApplications: number;
  occurrenceCount: number;
  avgConfidence: number;
}

export function CommunityFixBanner({
  alertId,
  fingerprint,
}: {
  alertId: string;
  fingerprint: string;
}) {
  const [fix, setFix] = useState<CommunityFixData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    fetch(`/api/community-fix?fingerprint=${encodeURIComponent(fingerprint)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => setFix(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fingerprint]);

  if (loading || !fix) return null;

  function handleApply() {
    startTransition(async () => {
      const result = await startRemediation(alertId);
      if (!result.error) setApplied(true);
    });
  }

  if (applied) {
    return (
      <section className="rounded-xl border border-emerald-900/30 bg-emerald-950/10 px-5 py-4">
        <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Community fix applied — remediation started
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-amber-900/30 bg-amber-950/10 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-amber-900/20">
        <Lightbulb className="h-4 w-4 text-amber-400" />
        <span className="text-xs font-medium uppercase tracking-wider text-amber-400">
          Community Fix Available
        </span>
      </div>

      <div className="px-5 py-4 space-y-3">
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5 text-zinc-300">
            <Users className="h-3.5 w-3.5 text-zinc-500" />
            <span>{fix.occurrenceCount} team{fix.occurrenceCount > 1 ? "s" : ""} hit this error</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`font-mono font-bold ${fix.successRate >= 90 ? "text-emerald-400" : fix.successRate >= 70 ? "text-amber-400" : "text-zinc-400"}`}>
              {fix.successRate}%
            </span>
            <span className="text-zinc-500">success rate</span>
            <span className="text-zinc-600 text-xs">({fix.successCount}/{fix.totalApplications})</span>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-[#0a0a0a] px-4 py-3 space-y-2">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Fix approach</p>
          <p className="text-sm text-zinc-300 leading-relaxed">{fix.fixApproach}</p>
          {fix.filesChanged.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {fix.filesChanged.map((f) => (
                <code key={f} className="text-xs font-mono text-zinc-500 bg-zinc-800/50 px-1.5 py-0.5 rounded">
                  {f}
                </code>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={handleApply}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50 transition-colors"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
          Apply Community Fix
        </button>
      </div>
    </section>
  );
}
