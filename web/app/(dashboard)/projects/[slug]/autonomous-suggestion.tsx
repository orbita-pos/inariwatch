"use client";

import { useTransition } from "react";
import { Sparkles, Loader2, X } from "lucide-react";
import { enableAutoRemediate, dismissAutonomousSuggestion } from "./auto-merge-actions";

export function AutonomousSuggestionBanner({
  projectId,
  approvalRate,
  remediationCount,
}: {
  projectId:        string;
  approvalRate:     number;
  remediationCount: number;
}) {
  const [isPending, start] = useTransition();

  return (
    <section
      role="region"
      aria-labelledby="autonomous-suggestion-heading"
      className="rounded-xl border border-violet-500/30 bg-violet-500/[0.04] px-5 py-4 flex items-start gap-4"
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10"
        aria-hidden="true"
      >
        <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-400" />
      </div>

      <div className="flex-1 min-w-0">
        <h2 id="autonomous-suggestion-heading" className="text-sm font-medium text-fg-strong">
          You&apos;re ready for autonomous mode
        </h2>
        <p className="mt-0.5 text-sm text-fg-base">
          Your last {remediationCount} AI fixes were approved {approvalRate}% of the time.
          Enable autonomous mode to skip the manual approval step.
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          disabled={isPending}
          onClick={() => start(async () => { await enableAutoRemediate(projectId); })}
          aria-busy={isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 dark:bg-violet-500 dark:hover:bg-violet-400 disabled:opacity-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
        >
          {isPending
            ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            : <Sparkles className="h-3 w-3" aria-hidden="true" />}
          Enable
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => start(async () => { await dismissAutonomousSuggestion(projectId); })}
          aria-label="Dismiss suggestion permanently"
          title="Dismiss permanently — this suggestion won't return for this project"
          className="rounded-lg p-1.5 text-fg-base/60 hover:text-fg-strong hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 disabled:opacity-50"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
