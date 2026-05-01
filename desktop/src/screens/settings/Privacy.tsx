import { Switch } from "@/components/ui";
import { useSettings } from "@/lib/store/settings";

export function SettingsPrivacy() {
  const privacy = useSettings((s) => s.privacy);
  const patchPrivacy = useSettings((s) => s.patchPrivacy);

  return (
    <section data-testid="settings-section-privacy" className="flex flex-col gap-5 max-w-xl">
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">Privacy</h2>
        <p className="text-sm text-[var(--muted)]">
          Inari is local-first. These toggles control what (if anything) leaves the machine.
        </p>
      </header>

      <Field
        label="Telemetry opt-out"
        hint="Stops anonymous usage events from being uploaded."
      >
        <Switch
          checked={privacy.telemetry_optout}
          onCheckedChange={(v) => patchPrivacy({ telemetry_optout: v })}
          data-testid="privacy-telemetry-toggle"
          aria-label="Telemetry opt-out"
        />
      </Field>

      <Field
        label="Local-only mode"
        hint="Disables Community Fix Network + EAP cloud verification. Your fixes never sync."
      >
        <Switch
          checked={privacy.local_only_mode}
          onCheckedChange={(v) => patchPrivacy({ local_only_mode: v })}
          data-testid="privacy-local-only-toggle"
          aria-label="Local-only mode"
        />
      </Field>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint ? <p className="text-xs text-[var(--muted)] mt-0.5">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
