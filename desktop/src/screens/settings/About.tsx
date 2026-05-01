import { useState } from "react";

import { Button } from "@/components/ui";
import {
  checkForUpdates,
  setReleaseChannel,
  type AboutInfo,
  type UpdateCheckResult,
} from "@/lib/main-ipc";
import { useSettings } from "@/lib/store/settings";

const CHANNELS = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
] as const;

export function SettingsAbout() {
  const about = useSettings((s) => s.about);
  const [latest, setLatest] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [localAbout, setLocalAbout] = useState<AboutInfo | null>(about);

  const visible = localAbout ?? about;
  if (!visible) {
    return (
      <section data-testid="settings-section-about" className="text-sm text-[var(--muted)]">
        Loading…
      </section>
    );
  }

  async function onChannelChange(channel: "stable" | "beta") {
    const next = await setReleaseChannel(channel);
    setLocalAbout(next);
  }

  async function onCheck() {
    setChecking(true);
    try {
      const result = await checkForUpdates();
      setLatest(result);
      // Mirror the new last-checked stamp.
      if (visible) setLocalAbout({ ...visible, last_update_check_ms: result.checked_at_ms });
    } finally {
      setChecking(false);
    }
  }

  return (
    <section data-testid="settings-section-about" className="flex flex-col gap-4 max-w-xl">
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">About</h2>
      </header>

      <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <span className="text-[var(--muted)]">Version</span>
        <span data-testid="about-version">{visible.version}</span>
        <span className="text-[var(--muted)]">Commit</span>
        <span className="font-mono text-xs">{visible.commit ?? "(dev)"}</span>
        <span className="text-[var(--muted)]">Last update check</span>
        <span>
          {visible.last_update_check_ms > 0
            ? new Date(visible.last_update_check_ms).toLocaleString()
            : "Never"}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm">Channel</span>
        <div className="flex gap-2">
          {CHANNELS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => onChannelChange(c.value)}
              data-testid={`about-channel-${c.value}`}
              className={[
                "px-3 h-8 text-sm rounded-[var(--radius-sm)] border",
                visible.channel === c.value
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={onCheck}
          disabled={checking}
          data-testid="about-check-updates"
        >
          {checking ? "Checking…" : "Check for updates"}
        </Button>
        {latest ? (
          <span className="text-xs text-[var(--muted)]" data-testid="about-update-result">
            {latest.message}
          </span>
        ) : null}
      </div>
    </section>
  );
}
