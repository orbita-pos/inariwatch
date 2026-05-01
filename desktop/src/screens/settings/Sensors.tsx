import { useState } from "react";

import { Button, Switch } from "@/components/ui";
import { installShellHooks, uninstallShellHooks } from "@/lib/main-ipc";
import { useSettings } from "@/lib/store/settings";

const SHELLS = ["zsh", "bash", "fish"] as const;
type ShellKind = (typeof SHELLS)[number];

export function SettingsSensors() {
  const sensors = useSettings((s) => s.sensors);
  const toggleSensor = useSettings((s) => s.toggleSensor);
  const [shell, setShell] = useState<ShellKind>("zsh");
  const [installedFor, setInstalledFor] = useState<string[]>(
    sensors?.shell_installed ?? [],
  );

  if (!sensors) {
    return (
      <section data-testid="settings-section-sensors" className="text-sm text-[var(--muted)]">
        Loading sensors…
      </section>
    );
  }

  const shellInstalled = installedFor.includes(shell);

  return (
    <section data-testid="settings-section-sensors" className="flex flex-col gap-5 max-w-2xl">
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">Sensors</h2>
        <p className="text-sm text-[var(--muted)]">
          Each sensor is a separate signal Inari can correlate. MCP is always on by design.
        </p>
      </header>

      <Row label="FS Watcher" description="Detects file changes in real time.">
        <Switch
          checked={sensors.fs_enabled}
          onCheckedChange={(v) => toggleSensor("fs", v)}
          aria-label="FS Watcher"
          data-testid="sensor-toggle-fs"
        />
      </Row>

      <Row label="MCP Server" description="Local AI tool surface — required for all assistant features.">
        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
          Always on
        </span>
      </Row>

      <Row
        label="Shell hooks"
        description="Captures terminal commands so Inari can correlate them with crashes."
      >
        <div className="flex items-center gap-2">
          <select
            value={shell}
            onChange={(e) => setShell(e.target.value as ShellKind)}
            className="h-8 px-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] text-xs"
            data-testid="shell-kind-select"
          >
            {SHELLS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant={shellInstalled ? "secondary" : "primary"}
            data-testid="shell-install-toggle"
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
          </Button>
        </div>
      </Row>

      <Row
        label="Git hooks"
        description="Pre-push gate runs the local subset of safety checks."
      >
        <span className="text-xs text-[var(--muted)]">
          {sensors.git_hooks_count > 0
            ? `${sensors.git_hooks_count} repo(s)`
            : "Per-repo — install from the Repos section"}
        </span>
      </Row>

      <Row
        label="HTTP proxy"
        description={`Captures HTTP traffic on port ${sensors.http_proxy_port}. Local-only.`}
      >
        <Switch
          checked={sensors.http_proxy_enabled}
          onCheckedChange={(v) => toggleSensor("http", v)}
          aria-label="HTTP proxy"
          data-testid="sensor-toggle-http"
        />
      </Row>

      <Row
        label="Substrate recording"
        description="Records I/O so fixes can replay against production-shape inputs."
      >
        <span className="text-xs text-[var(--muted)]">
          {sensors.substrate_any_repo
            ? "Enabled on at least one repo"
            : "Per-repo — toggle from the dock"}
        </span>
      </Row>
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={`sensor-row-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className="flex items-start justify-between gap-6 py-2 border-t border-[var(--border)]/40 first:border-t-0"
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-xs text-[var(--muted)] mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
