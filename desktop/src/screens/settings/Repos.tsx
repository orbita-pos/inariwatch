import { useEffect, useState } from "react";

import { Button, Dialog, DialogClose } from "@/components/ui";
import { useSettings } from "@/lib/store/settings";

export function SettingsRepos() {
  const repos = useSettings((s) => s.repos);
  const refreshRepos = useSettings((s) => s.refreshRepos);
  const wipeMemoryFor = useSettings((s) => s.wipeMemoryFor);
  const [pendingWipe, setPendingWipe] = useState<string | null>(null);

  useEffect(() => {
    void refreshRepos();
  }, [refreshRepos]);

  const target = repos.find((r) => r.id === pendingWipe);

  return (
    <section data-testid="settings-section-repos" className="flex flex-col gap-4 max-w-2xl">
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">Repos</h2>
        <p className="text-sm text-[var(--muted)]">
          Inari watches these locally. Wiping memory keeps your <code>memory.md</code> intact.
        </p>
      </header>

      {repos.length === 0 ? (
        <p className="text-sm text-[var(--muted)] py-6 text-center border border-dashed border-[var(--border)] rounded-[var(--radius-md)]">
          No repos opened yet. Drop one into the dock or use Onboarding.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="repos-list">
          {repos.map((repo) => (
            <li
              key={repo.id}
              data-testid={`repo-row-${repo.id}`}
              className="flex items-center gap-4 p-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{repo.name}</div>
                <div className="text-xs text-[var(--muted)] font-mono truncate">{repo.path}</div>
                <div className="text-xs text-[var(--muted)] mt-1">
                  {repo.symbol_count.toLocaleString()} symbols
                  {repo.last_indexed_at_ms
                    ? ` · last indexed ${formatRelative(repo.last_indexed_at_ms)}`
                    : " · not yet indexed"}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPendingWipe(repo.id)}
                data-testid={`wipe-button-${repo.id}`}
              >
                Wipe memory
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={pendingWipe !== null}
        onOpenChange={(o) => !o && setPendingWipe(null)}
        title="Wipe local memory?"
        description={
          target
            ? `This will delete the index for ${target.name}. Your memory.md will be preserved.`
            : "This action cannot be undone."
        }
      >
        <div className="flex justify-end gap-2 mt-4">
          <DialogClose asChild>
            <Button size="sm" variant="ghost" data-testid="wipe-cancel">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            variant="danger"
            data-testid="wipe-confirm"
            onClick={async () => {
              if (target) await wipeMemoryFor(target.id);
              setPendingWipe(null);
            }}
          >
            Wipe memory
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.max(1, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
