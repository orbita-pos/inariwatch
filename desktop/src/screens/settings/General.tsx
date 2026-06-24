import { useSettings } from "@/lib/store/settings";

import {
  Dropdown,
  Segmented,
  SettingsField,
  SettingsGroup,
  SettingsHeader,
  Toggle,
} from "./primitives";

const THEME_OPTIONS = [
  { value: "auto" as const, label: "System" },
  { value: "light" as const, label: "Light" },
  { value: "dark" as const, label: "Dark" },
];

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

export function SettingsGeneral() {
  const general = useSettings((s) => s.general);
  const patchGeneral = useSettings((s) => s.patchGeneral);

  return (
    <section data-testid="settings-section-general" className="flex flex-col">
      <SettingsHeader
        title="General"
        description="Theme follows your system unless you pin one."
      />

      <div className="mt-6" />

      <SettingsGroup eyebrow="Appearance">
        <SettingsField
          first
          label="Theme"
          control={
            <Segmented
              testId="theme-segmented"
              options={THEME_OPTIONS}
              value={general.theme}
              onChange={(next) => patchGeneral({ theme: next })}
            />
          }
        />
        <SettingsField
          label="Language"
          helper="More languages coming as the docs do."
          control={
            <Dropdown
              testId="language-dropdown"
              options={LANGUAGE_OPTIONS}
              value={general.language}
              onChange={(next) => patchGeneral({ language: next })}
              minWidth={160}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Sound">
        <SettingsField
          first
          label="Sound on critical alerts"
          helper="Plays a soft chime when an alert severity is critical."
          control={
            <Toggle
              testId="sound-critical-toggle"
              ariaLabel="Sound on critical alerts"
              on={general.sound_on_critical}
              onChange={(v) => patchGeneral({ sound_on_critical: v })}
            />
          }
        />
      </SettingsGroup>
    </section>
  );
}
