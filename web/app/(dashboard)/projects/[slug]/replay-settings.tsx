"use client";

import { useState, useTransition } from "react";
import { Film, Loader2, Lock, Zap } from "lucide-react";
import Link from "next/link";
import { updateReplaySettings } from "./replay-settings-actions";
import type { ReplaySettings } from "@/lib/db/schema";
import { DEFAULT_REPLAY_SETTINGS } from "@/lib/db/schema";

interface Props {
  projectId: string;
  isAdmin: boolean;
  replayV2Enabled: boolean;
  plan: "free" | "pro";
  initialSettings: ReplaySettings;
}

/**
 * Build the *effective* settings: whatever the project stored, plus defaults
 * for any missing field. This is what the UI mutates.
 */
function effective(stored: ReplaySettings): Required<ReplaySettings> {
  return { ...DEFAULT_REPLAY_SETTINGS, ...stored };
}

export function ReplaySettingsSection({
  projectId,
  isAdmin,
  replayV2Enabled,
  plan,
  initialSettings,
}: Props) {
  const [settings, setSettings] = useState<Required<ReplaySettings>>(effective(initialSettings));
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!replayV2Enabled) return null;

  const isPro = plan === "pro";
  const maxRetention = isPro ? 90 : 7;

  function patch(field: keyof Required<ReplaySettings>, value: string | number | boolean) {
    setSettings((s) => ({ ...s, [field]: value }));
    setSaved(false);
    setError(null);
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateReplaySettings(projectId, settings);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    });
  }

  const disabled = !isAdmin || isPending;
  const sessionLocked = !isPro;

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center gap-2">
        <Film className="h-4 w-4 text-fg-base/60" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-fg-strong">Replay V2 settings</h2>
        <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-surface-inner px-2 py-0.5 text-[11px] font-medium text-fg-base/70">
          {plan === "pro" ? "Pro" : "Free"}
        </span>
      </div>
      <p className="mb-5 text-xs text-fg-base/70">
        Controls what gets recorded and for how long. The SDK reads these on init;
        the server enforces sampling at ingest time.
      </p>

      <div className="space-y-5">
        {/* Master enable */}
        <Row label="Recording enabled" description="Master switch. When off, ingest rejects all blocks for this project.">
          <Toggle
            checked={settings.enabled}
            onChange={(v) => patch("enabled", v)}
            disabled={disabled}
          />
        </Row>

        {/* Error sample rate */}
        <Row
          label="Error sample rate"
          description="% of sessions that hit an uncaught error which get recorded. Rarely lowered below 100%."
        >
          <RateSlider
            value={settings.errorSampleRate}
            onChange={(v) => patch("errorSampleRate", v)}
            disabled={disabled || !settings.enabled}
          />
        </Row>

        {/* Session sample rate — Pro-gated */}
        <Row
          label={
            <span className="flex items-center gap-1.5">
              Session sample rate
              {sessionLocked && <Lock className="h-3 w-3 text-amber-500" aria-hidden="true" />}
            </span>
          }
          description={
            sessionLocked ? (
              <>
                % of error-free sessions to record. {" "}
                <Link href="/settings/billing" className="text-inari-accent underline underline-offset-2 hover:text-inari-accent/80">
                  Upgrade to Pro
                </Link>{" "}
                to enable.
              </>
            ) : (
              "% of error-free sessions to record. Useful for UX research — each recorded session costs R2 storage and your users' bandwidth."
            )
          }
        >
          <RateSlider
            value={sessionLocked ? 0 : settings.sessionSampleRate}
            onChange={(v) => patch("sessionSampleRate", v)}
            disabled={disabled || !settings.enabled || sessionLocked}
          />
        </Row>

        {/* Buffer seconds */}
        <Row
          label="Pre-error buffer"
          description="How many seconds of context before the error are kept in the client ring buffer."
        >
          <NumberInput
            value={settings.bufferSeconds}
            onChange={(v) => patch("bufferSeconds", v)}
            min={15}
            max={300}
            suffix="seconds"
            disabled={disabled}
          />
        </Row>

        {/* Retention */}
        <Row
          label="Retention"
          description={`How long recordings are kept. Max on ${plan === "pro" ? "Pro is 90 days" : "Free is 7 days"}.`}
        >
          <NumberInput
            value={settings.retentionDays}
            onChange={(v) => patch("retentionDays", v)}
            min={1}
            max={maxRetention}
            suffix="days"
            disabled={disabled}
          />
        </Row>

        {/* PII classifier */}
        <Row
          label="PII classifier"
          description="Strategy for masking password / credit-card / SSN fields automatically. AI tier uses GPT-4o-mini on ambiguous cases."
        >
          <select
            className="rounded-md border border-line bg-surface-inner px-3 py-1.5 text-sm text-fg-base disabled:opacity-50"
            value={String(settings.piiClassifier)}
            onChange={(e) => {
              const raw = e.target.value;
              patch("piiClassifier", raw === "false" ? false : raw);
            }}
            disabled={disabled}
          >
            <option value="ai">AI + heuristics (default)</option>
            <option value="heuristic">Heuristics only</option>
            <option value="false">Disabled (mask all inputs)</option>
          </select>
        </Row>
      </div>

      {isAdmin && (
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-inari-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Save settings
          </button>
          {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved.</span>}
          {error && <span className="max-w-[400px] truncate text-xs text-red-500" title={error}>{error}</span>}
        </div>
      )}

      {!isPro && (
        <div className="mt-5 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Free tier is capped at 100% error-session recording with 7-day retention.
            Pro unlocks UX-style sampling (0-100% of non-error sessions), 90-day retention,
            and per-route rules.{" "}
            <Link href="/settings/billing" className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-300">
              See plans →
            </Link>
          </span>
        </div>
      )}
    </section>
  );
}

// ── Presentational subcomponents ──────────────────────────────────────────

function Row({
  label,
  description,
  children,
}: {
  label: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-4">
      <div>
        <div className="text-sm font-medium text-fg-strong">{label}</div>
        <div className="mt-0.5 text-xs text-fg-base/70">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? "bg-inari-accent" : "bg-line-medium"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function RateSlider({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(parseInt(e.target.value, 10) / 100)}
        disabled={disabled}
        className="w-28 accent-inari-accent disabled:opacity-50"
      />
      <span className="w-10 text-right font-mono text-xs tabular-nums text-fg-base">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  suffix,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        disabled={disabled}
        className="w-16 rounded-md border border-line bg-surface-inner px-2 py-1 text-right font-mono text-xs text-fg-base disabled:opacity-50"
      />
      <span className="text-xs text-fg-base/60">{suffix}</span>
    </div>
  );
}
