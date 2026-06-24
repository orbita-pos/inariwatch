/**
 * S9 — health card for the Voice settings sub-tab.
 *
 * Renders ✓/✗ chips for the four capabilities the backend probes
 * (`whisper-cli` on PATH, whisper model on disk, Piper binary, Piper
 * model). When any chip is "missing", a `VoiceModelInstallHint`
 * accordion drops below with copy-paste install commands per OS.
 */

import { CheckCircle2, XCircle } from "lucide-react";

import type { VoiceCapabilities } from "@/lib/voice-ipc";
import { cn } from "@/lib/cn";

import { VoiceModelInstallHint } from "./VoiceModelInstallHint";

export interface VoiceCapabilitiesCardProps {
  capabilities: VoiceCapabilities;
  /** Override the platform detection — tests inject "win" / "mac" / "linux". */
  platformOverride?: "win" | "mac" | "linux";
}

interface Row {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export function VoiceCapabilitiesCard({
  capabilities,
  platformOverride,
}: VoiceCapabilitiesCardProps) {
  const rows: Row[] = [
    {
      key: "stt",
      label: "Whisper STT (whisper-cli on PATH)",
      ok: capabilities.stt_available,
      detail: capabilities.stt_binary_path || undefined,
    },
    {
      key: "stt-model",
      label: "Whisper model (ggml-base.en.bin)",
      ok: capabilities.whisper_model_present,
      detail: capabilities.whisper_model_path,
    },
    {
      key: "tts",
      label: "Piper TTS binary",
      ok: capabilities.tts_available,
    },
    {
      key: "tts-model",
      label: "At least one Piper voice model",
      ok: capabilities.piper_model_present,
    },
  ];

  const allOk = rows.every((r) => r.ok);
  const sttMissing = !capabilities.stt_available || !capabilities.whisper_model_present;

  return (
    <section
      data-testid="voice-capabilities-card"
      className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--card)] p-4"
    >
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-medium text-[var(--text)]">Voice health</h3>
        <span
          data-testid="voice-capabilities-overall"
          className={cn(
            "text-[11px] uppercase tracking-wide font-medium",
            allOk ? "text-[var(--success)]" : "text-[var(--text-muted)]",
          )}
        >
          {allOk ? "All systems go" : "Setup needed"}
        </span>
      </header>

      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li
            key={r.key}
            data-testid={`voice-cap-${r.key}`}
            className="flex items-start gap-2"
          >
            {r.ok ? (
              <CheckCircle2 className="h-4 w-4 mt-0.5 text-[var(--success)]" aria-hidden />
            ) : (
              <XCircle className="h-4 w-4 mt-0.5 text-[var(--text-muted)]" aria-hidden />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-[var(--text)]">{r.label}</div>
              {r.detail ? (
                <div className="text-[11px] text-[var(--text-muted)] truncate">{r.detail}</div>
              ) : null}
            </div>
            <span
              data-testid={`voice-cap-${r.key}-status`}
              className={cn(
                "text-[11px] uppercase tracking-wide",
                r.ok ? "text-[var(--success)]" : "text-[var(--text-muted)]",
              )}
            >
              {r.ok ? "ready" : "missing"}
            </span>
          </li>
        ))}
      </ul>

      {sttMissing ? (
        <div className="mt-4 pt-3 border-t border-[var(--border-subtle)]">
          <VoiceModelInstallHint platformOverride={platformOverride} />
        </div>
      ) : null}
    </section>
  );
}
