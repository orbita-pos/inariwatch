"use client";

import { useState, useEffect } from "react";
import { Eye, Loader2, AlertTriangle, Film, Shield } from "lucide-react";

// Risk threshold — fixes above this score are blocked from auto-merge.
// Mirrors the value used in lib/ai/prediction engine and the safety gates.
const PREDICTION_RISK_THRESHOLD = 40;

interface Prediction {
  error:                 string;
  file:                  string;
  line:                  number;
  confidence:            number;
  reason:                string;
  category:              string;
  communityFixAvailable: boolean;
  suggestedFix:          string;
}

interface ShadowReplayResult {
  totalRecordings: number;
  passed:          number;
  failed:          number;
  riskScore:       number;
  riskLevel:       string;
  summary:         string;
  recordings: {
    recordingId: string;
    passed:      boolean;
    exitCode:    number;
    divergences: { category: string; detail: string; severity: string }[];
    durationMs:  number;
  }[];
}

interface PredictionData {
  result: {
    predictions: Prediction[];
    overallRisk: string;
    summary:     string;
  };
  patternMatches: {
    fingerprint:     string;
    patternText:     string;
    occurrenceCount: number;
    successRate:     number;
  }[];
  shadowReplay: ShadowReplayResult | null;
}

const RISK_CARD_STYLES: Record<string, string> = {
  low:      "border-emerald-500/30 bg-emerald-500/[0.03]",
  medium:   "border-amber-500/30 bg-amber-500/[0.03]",
  high:     "border-red-500/30 bg-red-500/[0.03]",
  critical: "border-red-500/40 bg-red-500/[0.05]",
};

const RISK_PILL_STYLES: Record<string, string> = {
  low:      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  medium:   "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  high:     "bg-red-500/10 text-red-700 dark:text-red-400",
  critical: "bg-red-500/15 text-red-700 dark:text-red-400",
};

function confidenceColor(confidence: number): string {
  if (confidence >= 80) return "text-red-600 dark:text-red-400";
  if (confidence >= 50) return "text-amber-600 dark:text-amber-400";
  return "text-fg-base";
}

export function PredictionPanel({
  projectId,
  prNumber,
}: {
  projectId: string;
  prNumber:  number;
}) {
  const [data, setData]       = useState<PredictionData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/prediction", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ projectId, prNumber }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, prNumber]);

  if (loading) {
    return (
      <section
        role="status"
        aria-live="polite"
        className="rounded-xl border border-blue-500/30 bg-blue-500/5 px-5 py-4"
      >
        <div className="flex items-center gap-2 text-blue-700 dark:text-blue-400 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Running prediction engine…
        </div>
      </section>
    );
  }

  if (!data || (data.result.predictions.length === 0 && !data.shadowReplay)) return null;

  const risk          = data.result.overallRisk;
  const cardStyle     = RISK_CARD_STYLES[risk] ?? RISK_CARD_STYLES.low;
  const pillStyle     = RISK_PILL_STYLES[risk] ?? RISK_PILL_STYLES.low;

  return (
    <section
      aria-labelledby="prediction-heading"
      className={`rounded-xl border overflow-hidden ${cardStyle}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
        <Eye className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <h2 id="prediction-heading" className="text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
          Prediction Engine
        </h2>
        <span className={`ml-auto text-xs font-mono px-2 py-0.5 rounded-full ${pillStyle}`}>
          {risk.toUpperCase()} RISK
        </span>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Summary */}
        <p className="text-sm text-fg-base">{data.result.summary}</p>

        {/* Predictions */}
        {data.result.predictions.length > 0 && (
          <div className="rounded-lg border border-line bg-surface-inner overflow-hidden">
            <div className="px-3 py-1.5 bg-surface-dim border-b border-line-subtle">
              <h3 className="text-[10px] font-mono text-fg-base/70 uppercase tracking-wider">
                Predicted errors
              </h3>
            </div>
            <ul className="px-4 py-3 font-mono text-xs space-y-3">
              {data.result.predictions.map((p, i) => (
                <li key={i} className="flex items-start gap-2">
                  <AlertTriangle
                    className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${confidenceColor(p.confidence)}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-fg-strong">{p.error}</p>
                    <p className="text-fg-base/70">
                      {p.file}:{p.line} — {p.confidence}% confidence
                    </p>
                    <p className="text-fg-base/70 mt-1">{p.reason}</p>
                    {p.communityFixAvailable && (
                      <p className="text-emerald-700 dark:text-emerald-400 mt-1">
                        Fix available: {p.suggestedFix}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Shadow replay */}
        {data.shadowReplay && data.shadowReplay.totalRecordings > 0 && (
          <div className="rounded-lg border border-line bg-surface-inner overflow-hidden">
            <div className="px-3 py-1.5 bg-surface-dim border-b border-line-subtle flex items-center gap-2">
              <Film className="h-3 w-3 text-fg-base/60" aria-hidden="true" />
              <h3 className="text-[10px] font-mono text-fg-base/70 uppercase tracking-wider">
                Shadow execution — {data.shadowReplay.totalRecordings} recording{data.shadowReplay.totalRecordings !== 1 ? "s" : ""}
              </h3>
            </div>
            <div className="px-4 py-3 font-mono text-xs">
              <ul className="space-y-1.5">
                {data.shadowReplay.recordings.map((rec) => (
                  <li key={rec.recordingId} className="flex items-center gap-2">
                    <span
                      className={rec.passed ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}
                      aria-label={rec.passed ? "passed" : "failed"}
                    >
                      {rec.passed ? "✓" : "✗"}
                    </span>
                    <span className="text-fg-base">{rec.recordingId.slice(0, 8)}</span>
                    <span className="text-fg-base/60">({rec.durationMs}ms)</span>
                    {rec.divergences.length > 0 && (
                      <span className="text-red-700 dark:text-red-400 ml-auto truncate">
                        {rec.divergences[0].detail.slice(0, 50)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="pt-2 mt-2 border-t border-line-subtle flex items-center gap-2">
                <Shield className="h-3 w-3 text-fg-base/60" aria-hidden="true" />
                <span
                  className={
                    data.shadowReplay.riskScore > PREDICTION_RISK_THRESHOLD
                      ? "text-red-700 dark:text-red-400"
                      : "text-emerald-700 dark:text-emerald-400"
                  }
                >
                  Risk: {data.shadowReplay.riskScore}/100 ({data.shadowReplay.riskLevel})
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Pattern matches */}
        {data.patternMatches.length > 0 && (
          <div className="rounded-lg border border-line bg-surface-inner overflow-hidden">
            <div className="px-3 py-1.5 bg-surface-dim border-b border-line-subtle">
              <h3 className="text-[10px] font-mono text-fg-base/70 uppercase tracking-wider">
                Community patterns
              </h3>
            </div>
            <ul className="px-4 py-3 font-mono text-xs space-y-1">
              {data.patternMatches.map((p) => (
                <li key={p.fingerprint} className="flex items-center gap-2">
                  <span className="text-amber-700 dark:text-amber-400" aria-hidden="true">!</span>
                  <span className="text-fg-strong truncate">{p.patternText.slice(0, 60)}</span>
                  <span className="text-fg-base/70 ml-auto shrink-0">
                    {p.occurrenceCount} team{p.occurrenceCount !== 1 ? "s" : ""} · {p.successRate}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
