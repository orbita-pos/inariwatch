import { useState } from "react";

import { installShellHooks, uninstallShellHooks } from "@/lib/main-ipc";
import { useSettings } from "@/lib/store/settings";

import {
  Dropdown,
  GhostButton,
  SettingsField,
  SettingsGroup,
  SettingsHeader,
  Toggle,
} from "./primitives";

const SHELL_OPTIONS = [
  { value: "zsh", label: "zsh" },
  { value: "bash", label: "bash" },
  { value: "fish", label: "fish" },
] as const;
type ShellKind = (typeof SHELL_OPTIONS)[number]["value"];

export function SettingsSensors() {
  const sensors = useSettings((s) => s.sensors);
  const toggleSensor = useSettings((s) => s.toggleSensor);
  const [shell, setShell] = useState<ShellKind>("zsh");
  const [installedFor, setInstalledFor] = useState<string[]>(
    sensors?.shell_installed ?? [],
  );

  if (!sensors) {
    return (
      <section data-testid="settings-section-sensors">
        <SettingsHeader title="Sensors" />
        <p className="text-[12.5px] mt-4" style={{ color: "var(--text-subtle)" }}>
          Loading sensors…
        </p>
      </section>
    );
  }

  const shellInstalled = installedFor.includes(shell);

  return (
    <section data-testid="settings-section-sensors" className="flex flex-col">
      <SettingsHeader
        title="Sensors"
        description="Each sensor is a separate signal Inari can correlate. MCP is always on by design."
      />

      <div className="mt-6" />

      <SettingsGroup eyebrow="Filesystem">
        <SettingsField
          first
          label="FS Watcher"
          helper="Detects file changes in real time."
          control={
            <Toggle
              testId="sensor-toggle-fs"
              ariaLabel="FS Watcher"
              on={sensors.fs_enabled}
              onChange={(v) => toggleSensor("fs", v)}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        eyebrow="Shell hooks"
        description="Captures terminal commands so Inari can correlate them with crashes."
      >
        <SettingsField
          first
          label="Shell"
          control={
            <Dropdown
              testId="shell-kind-dropdown"
              options={SHELL_OPTIONS}
              value={shell}
              onChange={setShell}
              minWidth={120}
            />
          }
        />
        <SettingsField
          label={shellInstalled ? "Hook installed" : "Hook not installed"}
          helper={
            shellInstalled
              ? `Inari is reading from your ~/.${shell}rc`
              : `Inari will append a single source-line to ~/.${shell}rc`
          }
          control={
            <GhostButton
              testId="shell-install-toggle"
              onClick={async () => {
                if (shellInstalled) {
                  const next = await uninstallShellHooks(shell);
                  setInstalledFor(next.installed_for);
                } else {
                  const next = await installShellHooks(shell);
                  setInstalledFor(next.installed_for);
                }
              }}
            >
              {shellInstalled ? "Uninstall" : "Install"}
            </GhostButton>
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Network">
        <SettingsField
          first
          label="HTTP proxy"
          helper={`Captures HTTP traffic on port ${sensors.http_proxy_port}. Local-only.`}
          control={
            <Toggle
              testId="sensor-toggle-http"
              ariaLabel="HTTP proxy"
              on={sensors.http_proxy_enabled}
              onChange={(v) => toggleSensor("http", v)}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Per-repo signals" description="Configured from each repo's row in the Repos section.">
        <SettingsField
          first
          label="Git hooks"
          helper="Pre-push gate runs the local subset of safety checks."
          control={
            <span
              className="text-[11.5px]"
              style={{ color: "var(--text-subtle)" }}
            >
              {sensors.git_hooks_count > 0
                ? `${sensors.git_hooks_count} repo${sensors.git_hooks_count === 1 ? "" : "s"}`
                : "0 repos"}
            </span>
          }
        />
        <SettingsField
          label="Substrate recording"
          helper="Records I/O so fixes can replay against production-shape inputs."
          control={
            <span
              className="text-[11.5px]"
              style={{ color: "var(--text-subtle)" }}
            >
              {sensors.substrate_any_repo ? "Enabled on at least one repo" : "Disabled everywhere"}
            </span>
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="MCP" description="Local AI tool surface — required for all assistant features.">
        <SettingsField
          first
          label="MCP server"
          helper="Always on. Cannot be disabled without disabling the assistant entirely."
          control={
            <span
              className="inline-flex items-center gap-1.5"
              style={{
                height: 22,
                padding: "0 9px",
                borderRadius: 999,
                background:
                  "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
                border: "1px solid rgba(166,194,176,0.18)",
                color: "var(--verified)",
                fontSize: 11,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  background: "var(--verified)",
                }}
              />
              always on
            </span>
          }
        />
      </SettingsGroup>
    </section>
  );
}
