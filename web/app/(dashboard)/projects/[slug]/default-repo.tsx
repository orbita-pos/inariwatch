"use client";

import { useState, useTransition, useEffect } from "react";
import { GitBranch, Loader2 } from "lucide-react";
import { fetchProjectRepos, setDefaultRepo } from "./default-repo-actions";

/**
 * Default repository selector — the owner/repo used at remediation time
 * when the alert itself doesn't carry one (custom webhooks, legacy
 * alerts, sources without repo info). See migration 0068 +
 * `lib/webhooks/resolve-repo.ts`.
 */
export function DefaultRepoSection({
  projectId,
  isAdmin,
  currentValue,
}: {
  projectId: string;
  isAdmin: boolean;
  currentValue: string | null;
}) {
  const [value, setValue] = useState<string>(currentValue ?? "");
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [repos, setRepos] = useState<string[] | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    setLoadingRepos(true);
    fetchProjectRepos(projectId)
      .then(({ repos, owner, error }) => {
        if (error) setError(error);
        setRepos(repos);
        setOwner(owner);
      })
      .finally(() => setLoadingRepos(false));
  }, [projectId, isAdmin]);

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await setDefaultRepo(projectId, value);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    });
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-2 mb-1">
        <GitBranch className="h-4 w-4 text-fg-base/60" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-fg-strong">Default repository</h2>
      </div>
      <p className="text-[13px] text-fg-base/60 mb-4">
        Used for remediation when the alert doesn&apos;t carry a repo of its own.
        Capture, GitHub, Vercel, Sentry and Datadog webhooks already attach the
        repo at ingest; this field is the fallback for custom webhooks, manual
        alerts, and any historical rows that predate migration 0068.
      </p>

      {!isAdmin ? (
        <p className="text-[13px] text-fg-base/50">
          Only project admins can change this setting.
          {currentValue ? ` Current value: ${currentValue}.` : " No default set."}
        </p>
      ) : (
        <>
          <div className="flex gap-2">
            {repos && repos.length > 0 && owner ? (
              <select
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="flex-1 rounded-lg border border-line bg-bg-base px-3 py-2 text-sm text-fg-base focus:border-inari-accent focus:outline-none disabled:opacity-50"
                disabled={isPending}
              >
                <option value="">— none —</option>
                {repos.map((r) => (
                  <option key={r} value={`${owner}/${r}`}>
                    {owner}/{r}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={loadingRepos ? "Loading repositories…" : "owner/repo"}
                className="flex-1 rounded-lg border border-line bg-bg-base px-3 py-2 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent focus:outline-none disabled:opacity-50"
                disabled={isPending || loadingRepos}
              />
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending || loadingRepos || value === (currentValue ?? "")}
              className="inline-flex items-center gap-2 rounded-lg bg-inari-accent px-4 py-2 text-sm font-medium text-white hover:bg-inari-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </button>
          </div>
          {repos !== null && repos.length === 0 && (
            <p className="mt-2 text-[12px] text-amber-600 dark:text-amber-400">
              No GitHub integration connected. Connect one under Integrations → GitHub
              to populate the selector, or type an owner/repo manually.
            </p>
          )}
          {error && <p className="mt-2 text-[12px] text-red-500">{error}</p>}
          {saved && <p className="mt-2 text-[12px] text-emerald-600 dark:text-emerald-400">Saved.</p>}
        </>
      )}
    </section>
  );
}
