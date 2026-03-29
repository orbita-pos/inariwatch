"use client";

import { useState, useEffect } from "react";
import { Eye, Loader2, AlertTriangle, CheckCircle2, Film, Shield } from "lucide-react";

interface Prediction {
  error: string;
  file: string;
  line: number;
  confidence: number;
  reason: string;
  category: string;
  communityFixAvailable: boolean;
  suggestedFix: string;
}

interface ShadowReplayResult {
  totalRecordings: number;
  passed: number;
  failed: number;
  riskScore: number;
  riskLevel: string;
  summary: string;
  recordings: {
    recordingId: string;
    passed: boolean;
    exitCode: number;
    divergences: { category: string; detail: string; severity: string }[];
    durationMs: number;
  }[];
}

interface PredictionData {
  result: {
    predictions: Prediction[];
    overallRisk: string;
    summary: string;
  };
  patternMatches: {
    fingerprint: string;
    patternText: string;
    occurrenceCount: number;
    successRate: number;
  }[];
  shadowReplay: ShadowReplayResult | null;
}

export function PredictionPanel({
  projectId,
  prNumber,
}: {
  projectId: string;
  prNumber: number;
}) {
  const [data, setData] = useState<PredictionData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/prediction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, prNumber }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId, prNumber]);

  if (loading) {
    return (
      <section className="rounded-xl border border-blue-900/30 bg-blue-950/10 px-5 py-4">
        <div className="flex items-center gap-2 text-blue-400 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Running prediction engine...
        </div>
      </section>
    );
  }

  if (!data || (data.result.predictions.length === 0 && !data.shadowReplay)) return null;

  const riskColors: Record<string, string> = {
    low: "border-emerald-900/30 bg-emerald-950/10",
    medium: "border-amber-900/30 bg-amber-950/10",
    high: "border-red-900/30 bg-red-950/10",
    critical: "border-red-900/30 bg-red-950/10",
  };

  return (
    <section className={`rounded-xl border overflow-hidden ${riskColors[data.result.overallRisk] || riskColors.low}`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-white/5">
        <Eye className="h-4 w-4 text-amber-400" />
        <span className="text-xs font-medium uppercase tracking-wider text-amber-400">
          Prediction Engine
        </span>
        <span className={`ml-auto text-xs font-mono px-2 py-0.5 rounded-full ${
          data.result.overallRisk === "low" ? "bg-emerald-500/10 text-emerald-400" :
          data.result.overallRisk === "medium" ? "bg-amber-500/10 text-amber-400" :
          "bg-red-500/10 text-red-400"
        }`}>
          {data.result.overallRisk.toUpperCase()} RISK
        </span>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Summary */}
        <p className="text-sm text-fg-base">{data.result.summary}</p>

        {/* Predictions — terminal style */}
        {data.result.predictions.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-[#0a0a0a] overflow-hidden">
            <div className="px-3 py-1.5 bg-zinc-900/80 border-b border-zinc-800">
              <p className="text-[10px] font-mono text-zinc-500">PREDICTED ERRORS</p>
            </div>
            <div className="px-4 py-3 font-mono text-xs space-y-3">
              {data.result.predictions.map((p, i) => {
                const confColor = p.confidence >= 80 ? "text-red-400" : p.confidence >= 50 ? "text-amber-400" : "text-zinc-400";
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${confColor}`} />
                      <div>
                        <p className="text-zinc-200">{p.error}</p>
                        <p className="text-zinc-500">{p.file}:{p.line} — {p.confidence}% confidence</p>
                        <p className="text-zinc-500 mt-1">{p.reason}</p>
                        {p.communityFixAvailable && (
                          <p className="text-emerald-400 mt-1">Fix available: {p.suggestedFix}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Shadow replay — terminal style */}
        {data.shadowReplay && data.shadowReplay.totalRecordings > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-[#0a0a0a] overflow-hidden">
            <div className="px-3 py-1.5 bg-zinc-900/80 border-b border-zinc-800 flex items-center gap-2">
              <Film className="h-3 w-3 text-zinc-500" />
              <p className="text-[10px] font-mono text-zinc-500">
                SHADOW EXECUTION — {data.shadowReplay.totalRecordings} RECORDINGS
              </p>
            </div>
            <div className="px-4 py-3 font-mono text-xs space-y-1.5">
              {data.shadowReplay.recordings.map((rec) => (
                <div key={rec.recordingId} className="flex items-center gap-2">
                  <span className={rec.passed ? "text-emerald-400" : "text-red-400"}>
                    {rec.passed ? "✓" : "✗"}
                  </span>
                  <span className="text-zinc-500">{rec.recordingId.slice(0, 8)}</span>
                  <span className="text-zinc-600">({rec.durationMs}ms)</span>
                  {rec.divergences.length > 0 && (
                    <span className="text-red-400 ml-auto">{rec.divergences[0].detail.slice(0, 50)}</span>
                  )}
                </div>
              ))}
              <div className="pt-2 mt-2 border-t border-zinc-800 flex items-center gap-2">
                <Shield className="h-3 w-3 text-zinc-500" />
                <span className={`${
                  data.shadowReplay.riskScore >= 41 ? "text-red-400" : "text-emerald-400"
                }`}>
                  Risk: {data.shadowReplay.riskScore}/100 ({data.shadowReplay.riskLevel})
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Pattern matches */}
        {data.patternMatches.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-[#0a0a0a] overflow-hidden">
            <div className="px-3 py-1.5 bg-zinc-900/80 border-b border-zinc-800">
              <p className="text-[10px] font-mono text-zinc-500">COMMUNITY PATTERNS</p>
            </div>
            <div className="px-4 py-3 font-mono text-xs space-y-1">
              {data.patternMatches.map((p) => (
                <div key={p.fingerprint} className="flex items-center gap-2">
                  <span className="text-amber-400">!</span>
                  <span className="text-zinc-300">{p.patternText.slice(0, 60)}</span>
                  <span className="text-zinc-500 ml-auto">{p.occurrenceCount} teams · {p.successRate}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
