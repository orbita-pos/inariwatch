"use client";

import { useState, useTransition } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { analyzeAlert } from "./ai-actions";

interface Props {
  alertId: string;
  hasAIKey: boolean;
  aiReasoning: string | null;
}

export function AIAnalyzePanel({ alertId, hasAIKey, aiReasoning }: Props) {
  const [result, setResult] = useState(aiReasoning);
  const [error, setError] = useState("");
  const [isPending, start] = useTransition();

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

  if (!hasAIKey && !result) {
    return (
      <section className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[#1a1a1a] px-5 py-3">
          <Sparkles className="h-3.5 w-3.5 text-zinc-700" />
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">AI Analysis</span>
        </div>
        <div className="px-5 py-5 text-center">
          <p className="text-sm text-zinc-500">
            Add a Claude or OpenAI key in{" "}
            <a href="/settings" className="text-inari-accent hover:underline">
              Settings → AI
            </a>{" "}
            to get root cause analysis and remediation steps.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
      <div className="flex items-center justify-between border-b border-[#1a1a1a] px-5 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className={`h-3.5 w-3.5 ${result ? "text-inari-accent" : "text-zinc-600"}`} />
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">AI Analysis</span>
          {result && (
            <span className="rounded-full bg-inari-accent/10 px-2 py-0.5 text-[10px] font-medium text-inari-accent">
              Ready
            </span>
          )}
        </div>

        {hasAIKey && (
          <button
            onClick={handleAnalyze}
            disabled={isPending}
            className="flex items-center gap-1.5 rounded-lg border border-[#222] bg-[#111] px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-white hover:border-zinc-600 transition-all disabled:opacity-50"
          >
            {isPending ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Analyzing…
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" />
                {result ? "Re-analyze" : "Analyze"}
              </>
            )}
          </button>
        )}
      </div>

      <div className="px-5 py-5">
        {isPending && !result && (
          <div className="flex items-center gap-2 text-sm text-zinc-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking…
          </div>
        )}

        {error && (
          <p className="text-sm text-red-400 font-mono">{error}</p>
        )}

        {result && !isPending && (
          <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{result}</p>
        )}

        {!result && !isPending && !error && (
          <p className="text-sm text-zinc-600">
            Click "Analyze" to get AI-powered root cause analysis and remediation steps.
          </p>
        )}
      </div>
    </section>
  );
}
