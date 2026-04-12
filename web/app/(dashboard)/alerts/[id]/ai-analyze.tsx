"use client";

import { useState, useTransition } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { analyzeAlert } from "./ai-actions";

interface Props {
  alertId:     string;
  hasAIKey:    boolean;
  aiReasoning: string | null;
}

export function AIAnalyzePanel({ alertId, hasAIKey, aiReasoning }: Props) {
  const [result, setResult]   = useState(aiReasoning);
  const [error, setError]     = useState("");
  const [isPending, start]    = useTransition();

  const handleAnalyze = () => {
    setError("");
    start(async () => {
      const res = await analyzeAlert(alertId);
      if (res.error) {
        setError(res.error);
      } else if (res.reasoning) {
        setResult(res.reasoning);
      }
    });
  };

  return (
    <section
      aria-labelledby="ai-analysis-heading"
      className="rounded-xl border border-line bg-surface overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <Sparkles
            className={`h-3.5 w-3.5 ${result ? "text-inari-accent" : "text-fg-base/60"}`}
            aria-hidden="true"
          />
          <h2 id="ai-analysis-heading" className="text-xs font-medium uppercase tracking-wider text-fg-base/70">
            AI Analysis
          </h2>
          {result && (
            <span className="rounded-full bg-inari-accent/10 px-2 py-0.5 text-[10px] font-medium text-inari-accent">
              Ready
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleAnalyze}
          disabled={isPending}
          aria-busy={isPending}
          aria-describedby="ai-analysis-heading"
          className="flex items-center gap-1.5 rounded-lg border border-line-medium bg-surface-dim px-3 py-1.5 text-xs font-medium text-fg-base hover:text-fg-strong hover:border-line hover:bg-surface transition-all disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
        >
          {isPending ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Analyzing…
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {result ? "Re-analyze" : "Analyze"}
            </>
          )}
        </button>
      </div>

      <div className="px-5 py-5" aria-live="polite">
        {isPending && !result && (
          <div role="status" className="flex items-center gap-2 text-sm text-fg-base">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Thinking…
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 font-mono">{error}</p>
        )}

        {result && !isPending && (
          <p className="text-sm text-fg-base leading-relaxed whitespace-pre-wrap">{result}</p>
        )}

        {!result && !isPending && !error && (
          <p className="text-sm text-fg-base/70">
            Click &ldquo;Analyze&rdquo; to get AI-powered root cause analysis and remediation steps.
          </p>
        )}
      </div>
    </section>
  );
}
