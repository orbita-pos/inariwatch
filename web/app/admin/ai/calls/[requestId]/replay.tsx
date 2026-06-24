"use client";

import { useState } from "react";

interface ReplayModel {
  provider: string;
  model: string;
  label: string;
}

const REPLAY_MODELS: ReplayModel[] = [
  { provider: "openai", model: "gpt-5.4",                    label: "GPT-5.4 ($1.25/M)" },
  { provider: "openai", model: "gpt-5-mini",                 label: "GPT-5 mini ($0.25/M)" },
  { provider: "openai", model: "gpt-4o-mini",                label: "GPT-4o mini ($0.15/M)" },
  { provider: "claude", model: "claude-sonnet-4-6",          label: "Claude Sonnet 4.6 ($3/M)" },
  { provider: "claude", model: "claude-haiku-4-5-20251001",  label: "Claude Haiku 4.5 ($0.80/M)" },
  { provider: "groq",   model: "llama-3.1-8b-instant",       label: "Groq Llama 8B ($0.05/M)" },
];

interface ReplayResult {
  text: string;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function ReplayPanel({ requestId }: { requestId: string }) {
  const [selected, setSelected] = useState(REPLAY_MODELS[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runReplay() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/ai/calls/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, provider: selected.provider, model: selected.model }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <h3 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-3">
        Replay with different model
      </h3>
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={`${selected.provider}:${selected.model}`}
          onChange={(e) => {
            const [provider, model] = e.target.value.split(":");
            const m = REPLAY_MODELS.find((x) => x.provider === provider && x.model === model);
            if (m) setSelected(m);
          }}
          disabled={loading}
          className="px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-800 rounded text-white"
        >
          {REPLAY_MODELS.map((m) => (
            <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          onClick={runReplay}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed rounded"
        >
          {loading ? "Running…" : "Re-run"}
        </button>
      </div>

      {error && (
        <p className="mt-4 text-xs text-red-400">
          <span className="font-mono">error:</span> {error}
        </p>
      )}

      {result && (
        <div className="mt-4 border-t border-zinc-800 pt-4">
          <p className="text-xs text-zinc-400 mb-3">
            <span className="text-zinc-500">Replay with </span>
            <span className="font-mono text-white">{selected.model}</span>
            <span className="text-zinc-500"> · cost </span>
            <span className="font-mono">${result.costUsd.toFixed(6)}</span>
            <span className="text-zinc-500"> · </span>
            <span className="font-mono">{result.durationMs}ms</span>
            <span className="text-zinc-500"> · </span>
            <span className="font-mono">
              {result.inputTokens.toLocaleString()} → {result.outputTokens.toLocaleString()} tok
            </span>
          </p>
          <pre className="text-xs font-mono whitespace-pre-wrap bg-zinc-950 border border-zinc-800 rounded p-3 max-h-[50vh] overflow-auto">
            {result.text}
          </pre>
        </div>
      )}
    </div>
  );
}
