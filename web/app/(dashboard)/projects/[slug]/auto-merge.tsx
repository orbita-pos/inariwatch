"use client";

import { useState, useTransition, useId, useRef, useEffect } from "react";
import { Shield, Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { updateAutoMergeConfig } from "./auto-merge-actions";

type Config = {
  enabled:              boolean;
  minConfidence:        number;
  maxLinesChanged:      number;
  requireSelfReview:    boolean;
  postMergeMonitor:     boolean;
  autoRevert:           boolean;
  autoRemediate:        boolean;
  autoHeal:             boolean;
  predictionThreshold:  number;
  confidenceTunedAt?:   string;
  confidenceTunedFrom?: number;
};

function formatTuneAge(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function Toggle({
  checked,
  onChange,
  disabled,
  labelId,
  color = "default",
}: {
  checked:  boolean;
  onChange: () => void;
  disabled: boolean;
  labelId:  string;
  color?:   "default" | "amber" | "red";
}) {
  const onColor =
    color === "amber" ? "bg-amber-500" :
    color === "red"   ? "bg-red-500"   :
    "bg-inari-accent";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? onColor : "bg-zinc-200 dark:bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

export function AutoMergeSection({
  projectId,
  isAdmin,
  config,
}: {
  projectId: string;
  isAdmin:   boolean;
  config:    Config;
}) {
  const [form, setForm]              = useState<Config>(config);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved]            = useState(false);
  const [error, setError]            = useState<string | null>(null);
  const savedTimerRef                = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current); };
  }, []);

  const uid             = useId();
  const enabledId       = `${uid}-enabled`;
  const selfReviewId    = `${uid}-self-review`;
  const postMergeId     = `${uid}-post-merge`;
  const autoRevertId    = `${uid}-auto-revert`;
  const autoRemediateId = `${uid}-auto-remediate`;
  const autoHealId      = `${uid}-auto-heal`;
  const confId          = `${uid}-confidence`;
  const linesId         = `${uid}-lines`;

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateAutoMergeConfig(projectId, form);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
      }
    });
  }

  const hasChanges =
    form.enabled             !== config.enabled             ||
    form.minConfidence       !== config.minConfidence       ||
    form.maxLinesChanged     !== config.maxLinesChanged     ||
    form.requireSelfReview   !== config.requireSelfReview   ||
    form.postMergeMonitor    !== config.postMergeMonitor    ||
    form.autoRevert          !== config.autoRevert          ||
    form.autoRemediate       !== config.autoRemediate       ||
    form.autoHeal            !== config.autoHeal            ||
    form.predictionThreshold !== config.predictionThreshold;

  return (
    <section aria-labelledby="auto-merge-heading" className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
        <Shield className="h-4 w-4 text-inari-accent" aria-hidden="true" />
        <h2 id="auto-merge-heading" className="text-xs font-medium uppercase tracking-wider text-fg-base/70">
          Auto-Merge Settings
        </h2>
      </div>

      <div className="px-5 py-4 space-y-5">
        <p className="text-xs text-fg-base/70 leading-relaxed">
          When enabled, AI fixes that pass all safety gates will be auto-merged instead of creating draft PRs.
          Post-merge monitoring watches for regressions and auto-reverts if something goes wrong.
        </p>

        {/* Enable auto-merge */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <p id={enabledId} className="text-sm text-fg-strong">Enable auto-merge</p>
            <p className="text-xs text-fg-base/70">Allow AI to merge fixes automatically when all gates pass</p>
          </div>
          <Toggle
            checked={form.enabled}
            onChange={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
            disabled={!isAdmin}
            labelId={enabledId}
          />
        </div>

        {form.enabled && (
          <div className="space-y-4 pl-1 border-l-2 border-inari-accent/20 ml-1">

            {/* Min confidence */}
            <div className="pl-4">
              <label htmlFor={confId} className="text-sm text-fg-strong">Minimum confidence</label>
              <p className="text-xs text-fg-base/70 mb-1.5">AI fix must score at least this to auto-merge (0–100)</p>
              <div className="flex items-center gap-2">
                <input
                  id={confId}
                  type="number"
                  min={50}
                  max={100}
                  value={form.minConfidence}
                  disabled={!isAdmin}
                  onChange={(e) => setForm((f) => ({ ...f, minConfidence: Math.min(100, Math.max(50, Number(e.target.value) || 50)) }))}
                  className="w-24 rounded-lg border border-line-medium bg-surface-dim px-3 py-1.5 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-50"
                />
                <span className="text-xs text-fg-base/70">%</span>
              </div>
              {config.confidenceTunedAt && config.confidenceTunedFrom !== undefined && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  {config.confidenceTunedFrom > config.minConfidence
                    ? <TrendingDown className="h-3 w-3 text-inari-accent" aria-hidden="true" />
                    : <TrendingUp   className="h-3 w-3 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  }
                  <span className="text-[11px] text-fg-base/70">
                    Auto-tuned{" "}
                    <span className="text-fg-base font-medium">
                      {config.confidenceTunedFrom} → {config.minConfidence}
                    </span>
                    {" "}· {formatTuneAge(config.confidenceTunedAt)}
                  </span>
                </div>
              )}
            </div>

            {/* Max lines changed */}
            <div className="pl-4">
              <label htmlFor={linesId} className="text-sm text-fg-strong">Max lines changed</label>
              <p className="text-xs text-fg-base/70 mb-1.5">Fixes larger than this create a draft PR instead</p>
              <div className="flex items-center gap-2">
                <input
                  id={linesId}
                  type="number"
                  min={5}
                  max={500}
                  value={form.maxLinesChanged}
                  disabled={!isAdmin}
                  onChange={(e) => setForm((f) => ({ ...f, maxLinesChanged: Math.min(500, Math.max(5, Number(e.target.value) || 50)) }))}
                  className="w-24 rounded-lg border border-line-medium bg-surface-dim px-3 py-1.5 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-50"
                />
                <span className="text-xs text-fg-base/70">lines</span>
              </div>
            </div>

            {/* Require self-review */}
            <div className="flex items-center justify-between gap-3 pl-4">
              <div>
                <p id={selfReviewId} className="text-sm text-fg-strong">Require self-review</p>
                <p className="text-xs text-fg-base/70">AI reviews its own fix before merging</p>
              </div>
              <Toggle
                checked={form.requireSelfReview}
                onChange={() => setForm((f) => ({ ...f, requireSelfReview: !f.requireSelfReview }))}
                disabled={!isAdmin}
                labelId={selfReviewId}
              />
            </div>

            {/* Post-merge monitoring */}
            <div className="flex items-center justify-between gap-3 pl-4">
              <div>
                <p id={postMergeId} className="text-sm text-fg-strong">Post-merge monitoring</p>
                <p className="text-xs text-fg-base/70">Watch for regressions for 10 minutes after merge</p>
              </div>
              <Toggle
                checked={form.postMergeMonitor}
                onChange={() => setForm((f) => ({ ...f, postMergeMonitor: !f.postMergeMonitor }))}
                disabled={!isAdmin}
                labelId={postMergeId}
              />
            </div>

            {/* Auto-revert (conditional on post-merge monitoring) */}
            {form.postMergeMonitor && (
              <div className="flex items-center justify-between gap-3 pl-4">
                <div>
                  <p id={autoRevertId} className="text-sm text-fg-strong">Auto-revert on regression</p>
                  <p className="text-xs text-fg-base/70">Automatically revert if errors recur or uptime drops</p>
                </div>
                <Toggle
                  checked={form.autoRevert}
                  onChange={() => setForm((f) => ({ ...f, autoRevert: !f.autoRevert }))}
                  disabled={!isAdmin}
                  labelId={autoRevertId}
                />
              </div>
            )}

            {/* Autonomous remediation */}
            <div className="flex items-center justify-between gap-3 pl-4 pt-3 border-t border-line">
              <div>
                <p id={autoRemediateId} className="text-sm text-fg-strong">Autonomous mode</p>
                <p className="text-xs text-fg-base/70">Auto-trigger AI remediation on critical alerts — no human click needed</p>
              </div>
              <Toggle
                checked={form.autoRemediate}
                onChange={() => setForm((f) => ({ ...f, autoRemediate: !f.autoRemediate }))}
                disabled={!isAdmin}
                labelId={autoRemediateId}
                color="amber"
              />
            </div>

            {/* Auto-heal */}
            <div className="flex items-center justify-between gap-3 pl-4 pt-3 border-t border-line">
              <div>
                <p id={autoHealId} className="text-sm text-fg-strong">Auto-heal</p>
                <p className="text-xs text-fg-base/70">When uptime detects your site is down: rollback to last good deploy + start AI fix</p>
              </div>
              <Toggle
                checked={form.autoHeal}
                onChange={() => setForm((f) => ({ ...f, autoHeal: !f.autoHeal }))}
                disabled={!isAdmin}
                labelId={autoHealId}
                color="red"
              />
            </div>
          </div>
        )}

        {/* Save / feedback */}
        {isAdmin && hasChanges && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending}
              aria-busy={isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-inari-accent px-4 py-2 text-sm font-medium text-white hover:bg-inari-accent/90 disabled:opacity-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </button>
            {error && (
              <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>
            )}
          </div>
        )}

        {saved && (
          <p role="status" aria-live="polite" className="text-xs text-emerald-700 dark:text-emerald-400">
            Settings saved.
          </p>
        )}
      </div>
    </section>
  );
}
