"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { Server, Plus, Trash2, Loader2, Eye, EyeOff } from "lucide-react";
import { saveStagingEnvVars } from "./staging-env-actions";

type EnvVar = { key: string; value: string; masked: boolean };

export function StagingEnvSection({
  projectId,
  isAdmin,
  existingKeys,
}: {
  projectId:    string;
  isAdmin:      boolean;
  existingKeys: string[];
}) {
  const [vars, setVars] = useState<EnvVar[]>(
    existingKeys.length > 0
      ? existingKeys.map((k) => ({ key: k, value: "", masked: true }))
      : []
  );
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up the "saved" indicator timer on unmount
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  function addVar() {
    setVars([...vars, { key: "", value: "", masked: false }]);
  }

  function removeVar(idx: number) {
    setVars(vars.filter((_, i) => i !== idx));
  }

  function updateVar(idx: number, field: "key" | "value", val: string) {
    setVars(vars.map((v, i) => (i === idx ? { ...v, [field]: val, masked: false } : v)));
  }

  function toggleMask(idx: number) {
    setVars(vars.map((v, i) => (i === idx ? { ...v, masked: !v.masked } : v)));
  }

  function handleSave() {
    setError(null);
    setSaved(false);

    // Only send vars that have values (skip masked-only entries that weren't edited)
    const toSave = vars.filter((v) => v.key.trim() && v.value);

    startTransition(async () => {
      const result = await saveStagingEnvVars(projectId, toSave);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setVars(toSave.map((v) => ({ ...v, masked: true })));
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
      }
    });
  }

  return (
    <section
      aria-labelledby="staging-env-heading"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <div className="mb-4 flex items-center gap-2">
        <Server className="h-4 w-4 text-orange-600 dark:text-orange-400" aria-hidden="true" />
        <h2 id="staging-env-heading" className="text-sm font-semibold text-fg-strong">
          Staging Environment Variables
        </h2>
      </div>

      <p className="text-xs text-fg-base mb-4">
        Environment variables passed to ephemeral staging containers during AI remediation verification.
        Values are encrypted at rest and never shown after saving.
      </p>

      {/* Var list */}
      {vars.length > 0 && (
        <ul className="space-y-2 mb-4">
          {vars.map((v, idx) => {
            const keyId   = `env-key-${idx}`;
            const valueId = `env-value-${idx}`;
            const varLabel = v.key || `variable ${idx + 1}`;
            return (
              <li key={idx} className="flex items-center gap-2">
                <label htmlFor={keyId} className="sr-only">Variable key {idx + 1}</label>
                <input
                  id={keyId}
                  type="text"
                  placeholder="KEY"
                  value={v.key}
                  onChange={(e) => updateVar(idx, "key", e.target.value.toUpperCase())}
                  disabled={!isAdmin || isPending}
                  className="w-[180px] rounded-lg border border-line bg-surface-dim px-2.5 py-1.5 font-mono text-xs text-fg-strong placeholder:text-fg-base/40 focus:border-line-medium focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-60"
                />
                <span className="text-fg-base/60 text-xs" aria-hidden="true">=</span>
                <div className="flex-1 relative">
                  <label htmlFor={valueId} className="sr-only">Variable value {idx + 1}</label>
                  <input
                    id={valueId}
                    type={v.masked ? "password" : "text"}
                    placeholder={v.masked ? "••••••••" : "value"}
                    value={v.masked ? "" : v.value}
                    onChange={(e) => updateVar(idx, "value", e.target.value)}
                    disabled={!isAdmin || isPending}
                    className="w-full rounded-lg border border-line bg-surface-dim px-2.5 py-1.5 pr-8 font-mono text-xs text-fg-strong placeholder:text-fg-base/40 focus:border-line-medium focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => toggleMask(idx)}
                    aria-label={v.masked ? `Show value for ${varLabel}` : `Hide value for ${varLabel}`}
                    aria-pressed={!v.masked}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-base/60 hover:text-fg-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 rounded p-0.5"
                  >
                    {v.masked
                      ? <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
                  </button>
                </div>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => removeVar(idx)}
                    disabled={isPending}
                    aria-label={`Remove ${varLabel}`}
                    className="text-fg-base/60 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 rounded p-0.5"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Actions */}
      {isAdmin && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={addVar}
            disabled={isPending}
            className="flex items-center gap-1.5 rounded-lg border border-dashed border-line-medium px-3 py-1.5 text-xs text-fg-base hover:border-line hover:text-fg-strong hover:bg-surface-inner transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            Add variable
          </button>

          {vars.length > 0 && (
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending}
              aria-busy={isPending}
              className="flex items-center gap-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 px-3 py-1.5 text-xs font-medium text-orange-700 dark:text-orange-400 hover:bg-orange-500/15 hover:border-orange-500/40 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/50"
            >
              {isPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              Save
            </button>
          )}

          {saved && (
            <span role="status" aria-live="polite" className="text-xs text-emerald-700 dark:text-emerald-400">
              Saved
            </span>
          )}
          {error && (
            <span role="alert" className="text-xs text-red-700 dark:text-red-400">
              {error}
            </span>
          )}
        </div>
      )}

      {vars.length === 0 && (
        <p className="text-xs text-fg-base/70">
          No variables configured. The staging gate will be skipped during remediation.
        </p>
      )}
    </section>
  );
}
