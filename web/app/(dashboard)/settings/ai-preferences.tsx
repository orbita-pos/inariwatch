"use client";

// v0.3 S3 — AI Preferences settings card.
// v0.3 S4 — toggle now covers email + Slack + Telegram + push (4
// channels, 1 flag). The router's S4 rules in `packages/ai-router/src/
// rules.ts` re-use S3's `localNotifyEnabled` workspaceFlag for all four
// `notify.compose.*` channels, so the UI surface stays a single switch.
//
// When the user flips it ON, every `notify.compose.{email|slack|
// telegram|push|whatsapp}` dispatch the workspace makes routes through
// their local Inari Live (user-sidecar) instead of cloud. For email/
// slack/telegram/push, if the sidecar is offline/disconnected/times out
// the router falls back to cloud transparently per the rules'
// `fallbackTriggers` — the user never sees a hard failure. WhatsApp
// has NO cloud fallback (S5 Baileys rewrite — only the user's local
// QR-paired sidecar can send from their personal number); when offline
// the dispatch throws and the caller skips that surface.
//
// v0.3 S5 — second toggle: "Speak alerts on my machine" routes
// voice.tts.* (Piper) on Inari Live. Independent flag — workspaces can
// opt into voice without changing notify routing.

import { useState, useTransition } from "react";
import { Bot, AlertCircle } from "lucide-react";

import {
  setLocalNotifyEnabled,
  setLocalVoiceEnabled,
} from "./ai-preferences-actions";

interface Props {
  initial: boolean;
  /** v0.3 S5 — initial state for the voice toggle. */
  initialVoice: boolean;
  /**
   * Whether the active workspace is resolvable. When false (solo user
   * with no org row), we render the toggle disabled with a helper hint.
   */
  hasWorkspace: boolean;
}

export function AIPreferencesSection({
  initial,
  initialVoice,
  hasWorkspace,
}: Props) {
  const [enabled, setEnabled] = useState<boolean>(initial);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(initialVoice);
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

  function onVoiceToggle(next: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await setLocalVoiceEnabled(next);
      if (res.ok) {
        setVoiceEnabled(next);
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
            Compose notifications on my machine (Inari Live)
          </p>
          <p className="text-xs text-muted-foreground">
            When on, the prose for your alert notifications is written
            by your local model (Qwen2.5-Coder-1.5B) instead of the
            cloud. Stack traces never leave your computer for prose
            composition. Falls back to cloud if Inari Live is offline —
            you'll never miss an alert (except WhatsApp, which is
            local-only by design — see below).
          </p>
          <p className="text-xs text-muted-foreground">
            Covers <span className="font-medium">email</span>,{" "}
            <span className="font-medium">Slack</span>,{" "}
            <span className="font-medium">Telegram</span>,{" "}
            <span className="font-medium">push</span>, and{" "}
            <span className="font-medium">WhatsApp</span> notifications.
            The block layouts (Slack blocks, Telegram inline buttons)
            and transports stay cloud-side; only the human-facing text
            is local. WhatsApp goes one step further — the message is
            sent from your own number via the Inari Live Baileys
            sidecar, never through a cloud relay.
          </p>
          <p className="text-xs text-muted-foreground">
            Requires Inari Live installed and connected. Default OFF.
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Compose notifications on my machine"
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

      {/* v0.3 S5 — voice toggle. Separate from the notify toggle so opting
          into one doesn't enable the other. */}
      <div className="mt-6 flex items-start justify-between gap-6 border-t border-border/40 pt-6">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            Speak alerts on my machine (Piper TTS)
          </p>
          <p className="text-xs text-muted-foreground">
            When on, voice notifications are synthesized locally via Piper
            on your Inari Live. Cloud fallback uses OpenAI tts-1 — always
            audible. Requires voice models downloaded to Inari Live (≈
            30 MB per voice).
          </p>
          <p className="text-xs text-muted-foreground">
            Default OFF.
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={voiceEnabled}
          aria-label="Speak alerts on my machine"
          disabled={pending || !hasWorkspace}
          onClick={() => onVoiceToggle(!voiceEnabled)}
          className={
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
            (voiceEnabled ? "bg-emerald-500" : "bg-muted")
          }
        >
          <span
            className={
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform " +
              (voiceEnabled ? "translate-x-5" : "translate-x-0.5")
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
