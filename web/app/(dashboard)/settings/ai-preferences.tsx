"use client";

// v0.3 S3 — AI Preferences settings card.
//
// Single toggle for now: "Use my Inari Live to compose alert emails".
// When the user flips it ON, every `notify.compose.email` dispatch the
// workspace makes routes through their local Inari Live (user-sidecar)
// instead of OpenAI cloud. If the sidecar is offline, the router falls
// back to cloud transparently — the user never sees a hard failure.

import { useState, useTransition } from "react";
import { Bot, AlertCircle } from "lucide-react";

import { setLocalNotifyEnabled } from "./ai-preferences-actions";

interface Props {
  initial: boolean;
  /**
   * Whether the active workspace is resolvable. When false (solo user
   * with no org row), we render the toggle disabled with a helper hint.
   */
  hasWorkspace: boolean;
}

export function AIPreferencesSection({ initial, hasWorkspace }: Props) {
  const [enabled, setEnabled] = useState<boolean>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onToggle(next: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await setLocalNotifyEnabled(next);
      if (res.ok) {
        setEnabled(next);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <section className="rounded-xl border border-border/40 bg-card/40 p-6">
      <header className="mb-4 flex items-center gap-2">
        <Bot className="h-5 w-5 text-emerald-500" />
        <h2 className="text-base font-semibold">AI preferences</h2>
        <span className="ml-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          beta
        </span>
      </header>

      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            Compose alert emails on my machine (Inari Live)
          </p>
          <p className="text-xs text-muted-foreground">
            When on, alert email bodies are written by your local model
            (Qwen2.5-Coder-1.5B). Stack traces never leave your computer
            for prose composition. Falls back to cloud if Inari Live is
            offline — you'll never miss an alert.
          </p>
          <p className="text-xs text-muted-foreground">
            Requires Inari Live installed and connected. Default OFF.
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Compose alert emails on my machine"
          disabled={pending || !hasWorkspace}
          onClick={() => onToggle(!enabled)}
          className={
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
            (enabled
              ? "bg-emerald-500"
              : "bg-muted")
          }
        >
          <span
            className={
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform " +
              (enabled ? "translate-x-5" : "translate-x-0.5")
            }
          />
        </button>
      </div>

      {!hasWorkspace ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5" />
          Toggle disabled — your account isn't a member of any workspace yet.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
