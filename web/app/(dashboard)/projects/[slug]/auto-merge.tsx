"use client";

import { useState, useTransition } from "react";
import { Shield, Loader2 } from "lucide-react";
import { updateAutoMergeConfig } from "./auto-merge-actions";

type Config = {
  enabled: boolean;
  minConfidence: number;
  maxLinesChanged: number;
  requireSelfReview: boolean;
  postMergeMonitor: boolean;
  autoRevert: boolean;
  autoRemediate: boolean;
};

export function AutoMergeSection({
  projectId,
  isAdmin,
  config,
}: {
  projectId: string;
  isAdmin: boolean;
  config: Config;
}) {
  const [form, setForm] = useState<Config>(config);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateAutoMergeConfig(projectId, form);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    });
  }

  const hasChanges =
    form.enabled !== config.enabled ||
    form.minConfidence !== config.minConfidence ||
    form.maxLinesChanged !== config.maxLinesChanged ||
    form.requireSelfReview !== config.requireSelfReview ||
    form.postMergeMonitor !== config.postMergeMonitor ||
    form.autoRevert !== config.autoRevert ||
    form.autoRemediate !== config.autoRemediate;

  return (
    <section className="rounded-xl border border-[#222] bg-[#111] overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[#222]">
        <Shield className="h-4 w-4 text-cyan-400" />
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
          Auto-Merge Settings
        </span>
      </div>
      <div className="px-5 py-4 space-y-5">
        <p className="text-xs text-zinc-500 leading-relaxed">
          When enabled, AI fixes that pass all safety gates will be auto-merged instead of creating draft PRs.
          Post-merge monitoring watches for regressions and auto-reverts if something goes wrong.
        </p>

        {/* Enable toggle */}
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <div>
            <p className="text-sm text-zinc-300">Enable auto-merge</p>
            <p className="text-xs text-zinc-600">Allow AI to merge fixes automatically when all gates pass</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            disabled={!isAdmin}
            onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
              form.enabled ? "bg-cyan-600" : "bg-zinc-700"
            } ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform mt-0.5 ${
              form.enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`} />
          </button>
        </label>

        {form.enabled && (
          <div className="space-y-4 pl-1 border-l-2 border-cyan-900/30 ml-1">
            {/* Min confidence */}
            <div className="pl-4">
              <label className="text-sm text-zinc-300">Minimum confidence</label>
              <p className="text-xs text-zinc-600 mb-1.5">AI fix must score at least this to auto-merge (0-100)</p>
              <input
                type="number"
                min={50}
                max={100}
                value={form.minConfidence}
                disabled={!isAdmin}
                onChange={(e) => setForm((f) => ({ ...f, minConfidence: Math.min(100, Math.max(50, Number(e.target.value) || 50)) }))}
                className="w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white focus:border-cyan-600 focus:outline-none disabled:opacity-50"
              />
              <span className="text-xs text-zinc-600 ml-2">%</span>
            </div>

            {/* Max lines changed */}
            <div className="pl-4">
              <label className="text-sm text-zinc-300">Max lines changed</label>
              <p className="text-xs text-zinc-600 mb-1.5">Fixes larger than this create a draft PR instead</p>
              <input
                type="number"
                min={5}
                max={500}
                value={form.maxLinesChanged}
                disabled={!isAdmin}
                onChange={(e) => setForm((f) => ({ ...f, maxLinesChanged: Math.min(500, Math.max(5, Number(e.target.value) || 50)) }))}
                className="w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white focus:border-cyan-600 focus:outline-none disabled:opacity-50"
              />
              <span className="text-xs text-zinc-600 ml-2">lines</span>
            </div>

            {/* Self-review toggle */}
            <label className="flex items-center justify-between gap-3 cursor-pointer pl-4">
              <div>
                <p className="text-sm text-zinc-300">Require self-review</p>
                <p className="text-xs text-zinc-600">AI reviews its own fix before merging</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.requireSelfReview}
                disabled={!isAdmin}
                onClick={() => setForm((f) => ({ ...f, requireSelfReview: !f.requireSelfReview }))}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                  form.requireSelfReview ? "bg-cyan-600" : "bg-zinc-700"
                } ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform mt-0.5 ${
                  form.requireSelfReview ? "translate-x-[18px]" : "translate-x-0.5"
                }`} />
              </button>
            </label>

            {/* Post-merge monitor toggle */}
            <label className="flex items-center justify-between gap-3 cursor-pointer pl-4">
              <div>
                <p className="text-sm text-zinc-300">Post-merge monitoring</p>
                <p className="text-xs text-zinc-600">Watch for regressions for 10 minutes after merge</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.postMergeMonitor}
                disabled={!isAdmin}
                onClick={() => setForm((f) => ({ ...f, postMergeMonitor: !f.postMergeMonitor }))}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                  form.postMergeMonitor ? "bg-cyan-600" : "bg-zinc-700"
                } ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform mt-0.5 ${
                  form.postMergeMonitor ? "translate-x-[18px]" : "translate-x-0.5"
                }`} />
              </button>
            </label>

            {/* Auto-revert toggle */}
            {form.postMergeMonitor && (
              <label className="flex items-center justify-between gap-3 cursor-pointer pl-4">
                <div>
                  <p className="text-sm text-zinc-300">Auto-revert on regression</p>
                  <p className="text-xs text-zinc-600">Automatically revert if errors recur or uptime drops</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.autoRevert}
                  disabled={!isAdmin}
                  onClick={() => setForm((f) => ({ ...f, autoRevert: !f.autoRevert }))}
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                    form.autoRevert ? "bg-cyan-600" : "bg-zinc-700"
                  } ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform mt-0.5 ${
                    form.autoRevert ? "translate-x-[18px]" : "translate-x-0.5"
                  }`} />
                </button>
              </label>

            )}

            {/* Autonomous remediation toggle */}
            <label className="flex items-center justify-between gap-3 cursor-pointer pl-4 mt-3 pt-3 border-t border-[#222]">
              <div>
                <p className="text-sm text-zinc-300">Autonomous mode</p>
                <p className="text-xs text-zinc-600">Auto-trigger AI remediation on critical alerts — no human click needed</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.autoRemediate}
                disabled={!isAdmin}
                onClick={() => setForm((f) => ({ ...f, autoRemediate: !f.autoRemediate }))}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                  form.autoRemediate ? "bg-amber-600" : "bg-zinc-700"
                } ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform mt-0.5 ${
                  form.autoRemediate ? "translate-x-[18px]" : "translate-x-0.5"
                }`} />
              </button>
            </label>
          </div>
        )}

        {/* Save button */}
        {isAdmin && hasChanges && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </button>
            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>
        )}

        {saved && (
          <p className="text-xs text-emerald-400">Settings saved.</p>
        )}
      </div>
    </section>
  );
}
