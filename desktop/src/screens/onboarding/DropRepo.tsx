import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { RepoDropzone } from "@/components/RepoDropzone";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useOnboarding } from "@/lib/store/onboarding";

export function OnboardingDropRepo() {
  const repo = useOnboarding((s) => s.repo);
  const acceptRepo = useOnboarding((s) => s.acceptRepo);
  const pollProgress = useOnboarding((s) => s.pollProgress);
  const progress = useOnboarding((s) => s.progress);
  const setStep = useOnboarding((s) => s.setStep);
  const error = useOnboarding((s) => s.errorMessage);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return undefined;
    const id = window.setInterval(() => void pollProgress(), 500);
    return () => window.clearInterval(id);
  }, [repo, pollProgress]);

  // Auto-advance once the indexer hits done.
  useEffect(() => {
    if (repo && progress.stage === "done") {
      setStep("powerups");
    }
  }, [repo, progress.stage, setStep]);

  async function onBrowse() {
    setHint(null);
    try {
      const picked = await invoke<string | null>("desktop_pick_watch_dir");
      if (picked) {
        await acceptRepo(picked);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setHint(`Could not open folder picker: ${message}`);
    }
  }

  async function onAccept(path: string) {
    setHint(null);
    await acceptRepo(path);
  }

  return (
    <div data-testid="onboarding-step-drop" className="flex flex-col items-center gap-6 max-w-xl mx-auto py-10 px-4">
      <header className="text-center max-w-md">
        <h1 className="font-[var(--font-serif)] text-3xl mb-2">
          Drop your repository
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Inari watches code locally — no upload, nothing leaves your machine.
        </p>
      </header>

      {!repo ? (
        <RepoDropzone
          onAccept={onAccept}
          onBrowse={onBrowse}
          hint={hint ?? error ?? undefined}
        />
      ) : (
        <div
          data-testid="onboarding-progress"
          className="w-full max-w-md flex flex-col gap-3 p-4 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)]"
        >
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">{repo.name}</span>
            <span className="text-xs text-[var(--muted)]">{stageLabel(progress.stage)}</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-[var(--border)] overflow-hidden">
            <div
              data-testid="onboarding-progress-bar"
              className={cn(
                "h-full bg-[var(--accent)] transition-[width]",
                "duration-[var(--duration-base)]",
              )}
              style={{ width: `${Math.round(progress.percent * 100)}%` }}
            />
          </div>
          <p className="text-xs text-[var(--muted)] truncate">
            {progress.symbol_count > 0
              ? `${progress.symbol_count.toLocaleString()} symbols indexed`
              : "Walking the repo…"}
          </p>
          {progress.stage === "done" ? (
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={() => setStep("powerups")}
              data-testid="onboarding-continue"
            >
              Continue
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function stageLabel(stage: "scanning" | "indexing" | "done"): string {
  if (stage === "scanning") return "Walking files…";
  if (stage === "indexing") return "Indexing symbols…";
  return "Ready";
}
