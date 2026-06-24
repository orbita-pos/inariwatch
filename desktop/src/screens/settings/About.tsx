import { useState } from "react";

import {
  checkForUpdates,
  setReleaseChannel,
  type AboutInfo,
  type UpdateCheckResult,
} from "@/lib/main-ipc";
import { useSettings } from "@/lib/store/settings";

import {
  GhostButton,
  KvRow,
  Segmented,
  SettingsField,
  SettingsGroup,
  SettingsHeader,
} from "./primitives";

const CHANNELS = [
  { value: "stable" as const, label: "Stable" },
  { value: "beta" as const, label: "Beta" },
];

export function SettingsAbout() {
  const about = useSettings((s) => s.about);
  const [latest, setLatest] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [localAbout, setLocalAbout] = useState<AboutInfo | null>(about);

  const visible = localAbout ?? about;
  if (!visible) {
    return (
      <section data-testid="settings-section-about">
        <SettingsHeader title="About" />
        <p className="text-[12.5px] mt-4" style={{ color: "var(--text-subtle)" }}>
          Loading…
        </p>
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
      if (visible) setLocalAbout({ ...visible, last_update_check_ms: result.checked_at_ms });
    } finally {
      setChecking(false);
    }
  }

  const lastCheck =
    visible.last_update_check_ms > 0
      ? new Date(visible.last_update_check_ms).toLocaleString()
      : "Never";

  return (
    <section data-testid="settings-section-about" className="flex flex-col">
      <SettingsHeader
        title="About"
        description="Version, release channel, and update history."
      />

      <div className="mt-6" />

      <SettingsGroup eyebrow="Build">
        <KvRow k="version" v={<span data-testid="about-version">{visible.version}</span>} mono />
        <KvRow
          k="commit"
          v={<span style={{ color: visible.commit ? "var(--text)" : "var(--text-subtle)" }}>{visible.commit ?? "(dev)"}</span>}
          mono
        />
        <KvRow k="last update check" v={lastCheck} />
      </SettingsGroup>

      <SettingsGroup eyebrow="Updates" description="Stable lags beta by ~2 weeks of bake time.">
        <SettingsField
          first
          label="Release channel"
          control={
            <Segmented<"stable" | "beta">
              testId="about-channel-segmented"
              options={CHANNELS}
              value={visible.channel as "stable" | "beta"}
              onChange={(next) => void onChannelChange(next)}
            />
          }
        />
        <SettingsField
          label="Check for updates"
          helper={
            latest ? (
              <span data-testid="about-update-result">{latest.message}</span>
            ) : (
              "Inari Live polls automatically once a day. Manual check forces a roundtrip."
            )
          }
          control={
            <GhostButton
              testId="about-check-updates"
              onClick={() => void onCheck()}
            >
              {checking ? "Checking…" : "Check now"}
            </GhostButton>
          }
        />
      </SettingsGroup>
    </section>
  );
}
