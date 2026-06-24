/**
 * S9 — copy-paste install hints for whisper-cli + base model.
 *
 * Shipped behind `VoiceCapabilitiesCard` when STT prerequisites are
 * missing. Hardcoded URLs / commands per OS so the user has a clear
 * "do this and restart" path. NO auto-downloads — that UX is S9.5.
 *
 * Detection order:
 *   1. Explicit `platformOverride` prop (tests).
 *   2. `navigator.userAgentData.platform` (Chromium UAv2).
 *   3. `navigator.platform` (legacy fallback).
 *   4. `linux` if nothing matches (safest install path).
 */

import { Copy } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "@/lib/cn";

export type SupportedPlatform = "win" | "mac" | "linux";

const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

const WHISPER_RELEASES_URL = "https://github.com/ggerganov/whisper.cpp/releases";

interface PlatformHint {
  label: string;
  installSteps: { caption: string; command: string }[];
  modelSteps: { caption: string; command: string }[];
}

const HINTS: Record<SupportedPlatform, PlatformHint> = {
  win: {
    label: "Windows",
    installSteps: [
      {
        caption: "Download the latest whisper.cpp Windows release ZIP",
        command: WHISPER_RELEASES_URL,
      },
      {
        caption: "Extract and add the bin folder to PATH (PowerShell)",
        command: '$env:Path += ";$HOME\\whisper.cpp\\bin"',
      },
    ],
    modelSteps: [
      {
        caption: "Download the base.en model (~147 MB)",
        command: `curl.exe -L "${WHISPER_MODEL_URL}" -o "$HOME\\.inari\\voice\\models\\ggml-base.en.bin"`,
      },
    ],
  },
  mac: {
    label: "macOS",
    installSteps: [
      {
        caption: "Install via Homebrew",
        command: "brew install whisper-cpp",
      },
    ],
    modelSteps: [
      {
        caption: "Download the base.en model (~147 MB)",
        command: `mkdir -p ~/.inari/voice/models && curl -L "${WHISPER_MODEL_URL}" -o ~/.inari/voice/models/ggml-base.en.bin`,
      },
    ],
  },
  linux: {
    label: "Linux",
    installSteps: [
      {
        caption: "Build whisper.cpp from source",
        command:
          "git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && make && sudo cp main /usr/local/bin/whisper-cli",
      },
    ],
    modelSteps: [
      {
        caption: "Download the base.en model (~147 MB)",
        command: `mkdir -p ~/.inari/voice/models && curl -L "${WHISPER_MODEL_URL}" -o ~/.inari/voice/models/ggml-base.en.bin`,
      },
    ],
  },
};

function detectPlatform(): SupportedPlatform {
  const nav = (globalThis as unknown as {
    navigator?: {
      userAgentData?: { platform?: string };
      platform?: string;
    };
  }).navigator;
  const raw = (nav?.userAgentData?.platform || nav?.platform || "").toLowerCase();
  if (raw.includes("win")) return "win";
  if (raw.includes("mac") || raw.includes("darwin") || raw.includes("ios")) return "mac";
  if (raw.includes("linux") || raw.includes("freebsd") || raw.includes("x11")) return "linux";
  return "linux";
}

export interface VoiceModelInstallHintProps {
  platformOverride?: SupportedPlatform;
}

export function VoiceModelInstallHint({
  platformOverride,
}: VoiceModelInstallHintProps) {
  const platform = useMemo<SupportedPlatform>(
    () => platformOverride ?? detectPlatform(),
    [platformOverride],
  );
  const hint = HINTS[platform];
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1200);
    } catch {
      // Best-effort — UI just doesn't flash "copied".
    }
  }, []);

  return (
    <div
      data-testid="voice-install-hint"
      data-platform={platform}
      className="flex flex-col gap-3"
    >
      <header className="flex items-center justify-between">
        <h4 className="text-[12px] uppercase tracking-wide text-[var(--text-muted)]">
          Install whisper.cpp ({hint.label})
        </h4>
      </header>

      <Section
        title="1) Install whisper-cli"
        steps={hint.installSteps}
        onCopy={copy}
        copiedKey={copiedKey}
        groupKey="install"
      />
      <Section
        title="2) Download base.en model"
        steps={hint.modelSteps}
        onCopy={copy}
        copiedKey={copiedKey}
        groupKey="model"
      />

      <p className="text-[11px] text-[var(--text-muted)]">
        After both steps, return to Settings → Voice and toggle{" "}
        <span className="text-[var(--text)]">Voice input</span>. The capabilities check above
        re-runs each time the panel opens.
      </p>
    </div>
  );
}

interface SectionProps {
  title: string;
  steps: { caption: string; command: string }[];
  onCopy: (key: string, text: string) => Promise<void>;
  copiedKey: string | null;
  groupKey: string;
}

function Section({ title, steps, onCopy, copiedKey, groupKey }: SectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <h5 className="text-[12px] font-medium text-[var(--text)]">{title}</h5>
      {steps.map((s, idx) => {
        const key = `${groupKey}-${idx}`;
        return (
          <div key={key} className="flex flex-col gap-1">
            <div className="text-[11px] text-[var(--text-muted)]">{s.caption}</div>
            <div className="flex items-center gap-2">
              <code
                data-testid={`voice-install-${key}-cmd`}
                className="flex-1 text-[11px] font-mono bg-[var(--bg)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] px-2 py-1 break-all"
              >
                {s.command}
              </code>
              <button
                type="button"
                aria-label={`Copy ${s.caption}`}
                data-testid={`voice-install-${key}-copy`}
                onClick={() => void onCopy(key, s.command)}
                className={cn(
                  "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
                  "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--card)]",
                  "transition-colors duration-[var(--duration-fast)] outline-none cursor-pointer",
                  "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                )}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden />
              </button>
              {copiedKey === key ? (
                <span className="text-[11px] text-[var(--success)]">copied</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
