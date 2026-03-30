"use client";

import { useTransition } from "react";
import { Sparkles, Loader2, X } from "lucide-react";
import { enableAutoRemediate, dismissAutonomousSuggestion } from "./auto-merge-actions";

export function AutonomousSuggestionBanner({
  projectId,
  approvalRate,
  remediationCount,
}: {
  projectId: string;
  approvalRate: number;
  remediationCount: number;
}) {
  const [isPending, start] = useTransition();

  return (
    <div className="rounded-xl border border-violet-500/20 bg-violet-950/10 px-5 py-4 flex items-start gap-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
        <Sparkles className="h-4 w-4 text-violet-400" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-fg-strong">
          You're ready for autonomous mode
        </p>
        <p className="mt-0.5 text-sm text-zinc-400">
          Your last {remediationCount} AI fixes were approved {approvalRate}% of the time.
          Enable autonomous mode to skip the manual approval step.
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          disabled={isPending}
          onClick={() => start(async () => { await enableAutoRemediate(projectId); })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          Enable
        </button>
        <button
          disabled={isPending}
          onClick={() => start(async () => { await dismissAutonomousSuggestion(projectId); })}
          className="rounded-lg p-1.5 text-zinc-500 hover:text-fg-base transition-colors"
          title="Not yet"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
