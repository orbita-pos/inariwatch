"use client";

import { useState, useTransition } from "react";
import { Globe, Plus, Trash2, Loader2, ShieldCheck } from "lucide-react";
import { updateAllowedOrigins } from "./allowed-origins-actions";

const MAX_ENTRIES = 20;

export function AllowedOriginsSection({
  projectId,
  isAdmin,
  replayV2Enabled,
  initialEntries,
}: {
  projectId: string;
  isAdmin: boolean;
  replayV2Enabled: boolean;
  initialEntries: string[];
}) {
  const [entries, setEntries] = useState<string[]>(initialEntries);
  const [draft, setDraft] = useState("");
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This feature is coupled to Replay V2 — don't show it for orgs that
  // haven't opted into the flag yet. Once Replay V2 goes GA, remove the gate.
  if (!replayV2Enabled) return null;

  function addEntry() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (entries.includes(trimmed)) {
      setError("Entry already in the list.");
      return;
    }
    if (entries.length >= MAX_ENTRIES) {
      setError(`At most ${MAX_ENTRIES} entries.`);
      return;
    }
    setEntries([...entries, trimmed]);
    setDraft("");
    setError(null);
  }

  function removeEntry(idx: number) {
    setEntries(entries.filter((_, i) => i !== idx));
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateAllowedOrigins(projectId, entries);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    });
  }

  const strictMode = entries.length > 0;

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-2 mb-1">
        <Globe className="h-4 w-4 text-fg-base/60" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-fg-strong">Allowed origins (Replay V2)</h2>
        {strictMode ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3 w-3" aria-hidden="true" />
            Strict
          </span>
        ) : (
          <span className="ml-auto rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            Open (any origin)
          </span>
        )}
      </div>
      <p className="text-xs text-fg-base/70 mb-4">
        Domains that are allowed to POST replay blocks and call the PII
        classifier. Leave the list empty to accept any origin (current default,
        not recommended for production). Wildcards like{" "}
        <code className="font-mono bg-surface-dim px-1 rounded">https://*.example.com</code>{" "}
        match subdomains only —{" "}
        <strong>add the root separately</strong> (e.g.{" "}
        <code className="font-mono bg-surface-dim px-1 rounded">https://example.com</code>)
        if your app also runs there.
      </p>

      {entries.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {entries.map((e, i) => (
            <li
              key={e}
              className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface-inner px-3 py-2 text-sm"
            >
              <code className="font-mono text-xs text-fg-base">{e}</code>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => removeEntry(i)}
                  className="text-fg-base/50 hover:text-red-500 transition-colors"
                  aria-label={`Remove ${e}`}
                  disabled={isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="url"
              placeholder="https://app.example.com"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addEntry();
                }
              }}
              className="flex-1 rounded-md border border-line bg-surface-inner px-3 py-1.5 text-sm text-fg-base placeholder:text-fg-base/40 focus:outline-none focus:border-inari-accent"
              disabled={isPending || entries.length >= MAX_ENTRIES}
            />
            <button
              type="button"
              onClick={addEntry}
              disabled={isPending || !draft.trim() || entries.length >= MAX_ENTRIES}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-fg-base hover:bg-black/[0.04] dark:hover:bg-white/[0.05] disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add
            </button>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-inari-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Save
            </button>
            {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved.</span>}
            {error && <span className="text-xs text-red-500 max-w-[400px] truncate" title={error}>{error}</span>}
          </div>
        </>
      )}
    </section>
  );
}
