import { Switch } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  useOnboarding,
  type PowerUpsState,
  type ShellKind,
} from "@/lib/store/onboarding";

interface PowerUpRow {
  key: keyof PowerUpsState;
  label: string;
  description: string;
  preview: (shell: ShellKind) => string;
}

const ROWS: PowerUpRow[] = [
  {
    key: "watchTerminal",
    label: "Watch terminal",
    description: "Capture commands you run so Inari can correlate them with crashes.",
    preview: (shell) => `Will add 1 line to ~/.${shell}rc`,
  },
  {
    key: "blockBadPushes",
    label: "Block bad pushes",
    description: "Pre-push hook runs the same gate the cloud uses.",
    preview: () => "Will install a pre-push git hook",
  },
  {
    key: "vscodeExtension",
    label: "See my cursor (VS Code ext)",
    description: "Inari highlights the function it's reasoning about, live.",
    preview: () => "Will install the VS Code extension",
  },
  {
    key: "httpTraffic",
    label: "Capture HTTP traffic",
    description: "Local mitmproxy on port 9876 — never leaves your machine.",
    preview: () => "Will configure HTTP proxy on port 9876",
  },
];

export function PowerUpToggles() {
  const powerUps = useOnboarding((s) => s.powerUps);
  const togglePowerUp = useOnboarding((s) => s.togglePowerUp);
  const shellKind = useOnboarding((s) => s.shellKind);
  const lastResult = useOnboarding((s) => s.lastPowerUpResult);

  return (
    <div className="flex flex-col gap-3 w-full max-w-md">
      {ROWS.map((row) => {
        const checked = powerUps[row.key];
        return (
          <div
            key={row.key}
            data-testid={`powerup-${row.key}`}
            className={cn(
              "flex items-start gap-3 p-3 rounded-[var(--radius-lg)]",
              "border border-[var(--border)] bg-[var(--surface)]",
            )}
          >
            <Switch
              checked={checked}
              onCheckedChange={(v) => togglePowerUp(row.key, v)}
              aria-label={row.label}
              data-testid={`powerup-${row.key}-switch`}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium leading-tight">{row.label}</div>
              <p className="text-xs text-[var(--muted)] mt-0.5">{row.description}</p>
              <p className="text-[0.7rem] text-[var(--muted)] mt-1 font-mono">
                {row.preview(shellKind)}
              </p>
            </div>
          </div>
        );
      })}
      {lastResult ? (
        <p
          className="text-xs text-[var(--muted)]"
          data-testid="powerup-last-result"
          role="status"
        >
          {lastResult.message}
        </p>
      ) : null}
    </div>
  );
}
