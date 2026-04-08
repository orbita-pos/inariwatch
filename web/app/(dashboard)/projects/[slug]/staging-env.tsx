"use client";

import { useState, useTransition } from "react";
import { Server, Plus, Trash2, Loader2, Eye, EyeOff } from "lucide-react";
import { saveStagingEnvVars } from "./staging-env-actions";

type EnvVar = { key: string; value: string; masked: boolean };

export function StagingEnvSection({
  projectId,
  isAdmin,
  existingKeys,
}: {
  projectId: string;
  isAdmin: boolean;
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
        // Mark all as masked after save
        setVars(toSave.map((v) => ({ ...v, masked: true })));
        setTimeout(() => setSaved(false), 3000);
      }
    });
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-4 flex items-center gap-2">
        <Server className="h-4 w-4 text-orange-400" />
        <h2 className="text-sm font-semibold text-fg-strong">Staging Environment Variables</h2>
      </div>

      <p className="text-xs text-zinc-500 mb-4">
        Environment variables passed to ephemeral staging containers during AI remediation verification.
        Values are encrypted at rest and never shown after saving.
      </p>

      {/* Var list */}
      <div className="space-y-2 mb-4">
        {vars.map((v, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              type="text"
              placeholder="KEY"
              value={v.key}
              onChange={(e) => updateVar(idx, "key", e.target.value.toUpperCase())}
              disabled={!isAdmin || isPending}
              className="w-[180px] rounded-lg border border-line bg-surface-dim px-2.5 py-1.5 font-mono text-xs text-fg-base placeholder:text-zinc-600 focus:border-line-medium focus:outline-none"
            />
            <span className="text-zinc-600 text-xs">=</span>
            <div className="flex-1 relative">
              <input
                type={v.masked ? "password" : "text"}
                placeholder={v.masked ? "••••••••" : "value"}
                value={v.masked ? "" : v.value}
                onChange={(e) => updateVar(idx, "value", e.target.value)}
                disabled={!isAdmin || isPending}
                className="w-full rounded-lg border border-line bg-surface-dim px-2.5 py-1.5 pr-8 font-mono text-xs text-fg-base placeholder:text-zinc-600 focus:border-line-medium focus:outline-none"
              />
              <button
                type="button"
                onClick={() => toggleMask(idx)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400"
              >
                {v.masked ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() => removeVar(idx)}
                disabled={isPending}
                className="text-zinc-600 hover:text-red-400 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Actions */}
      {isAdmin && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={addVar}
            disabled={isPending}
            className="flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-1.5 text-xs text-zinc-500 hover:border-line-medium hover:text-fg-base transition-colors"
          >
            <Plus className="h-3 w-3" /> Add variable
          </button>

          {vars.length > 0 && (
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending}
              className="flex items-center gap-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-1.5 text-xs text-orange-400 hover:bg-orange-500/20 transition-colors"
            >
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Save
            </button>
          )}

          {saved && <span className="text-xs text-green-500">Saved</span>}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      )}

      {vars.length === 0 && (
        <p className="text-xs text-zinc-600">
          No variables configured. The staging gate will be skipped during remediation.
        </p>
      )}
    </section>
  );
}
