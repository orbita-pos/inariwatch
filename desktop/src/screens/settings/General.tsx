import { Switch } from "@/components/ui";
import { useSettings } from "@/lib/store/settings";

const THEMES: Array<{ value: "auto" | "light" | "dark"; label: string }> = [
  { value: "auto",  label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark",  label: "Dark" },
];

const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

export function SettingsGeneral() {
  const general = useSettings((s) => s.general);
  const patchGeneral = useSettings((s) => s.patchGeneral);

  return (
    <section data-testid="settings-section-general" className="flex flex-col gap-6 max-w-xl">
      <Header title="General" subtitle="Theme, language, and ambient sound." />

      <Field label="Theme" hint="Auto follows your OS appearance.">
        <div className="flex gap-2" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={general.theme === t.value}
              onClick={() => patchGeneral({ theme: t.value })}
              data-testid={`theme-option-${t.value}`}
              className={[
                "px-3 h-8 text-sm rounded-[var(--radius-sm)] border",
                general.theme === t.value
                  ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Language" hint="More languages coming as the docs do.">
        <select
          value={general.language}
          onChange={(e) => patchGeneral({ language: e.target.value })}
          className="h-9 px-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] text-sm"
          data-testid="language-select"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </Field>

      <Field label="Sound on critical alerts" hint="Plays a soft chime for severity 'critical'.">
        <Switch
          checked={general.sound_on_critical}
          onCheckedChange={(v) => patchGeneral({ sound_on_critical: v })}
          data-testid="sound-critical-toggle"
          aria-label="Sound on critical alerts"
        />
      </Field>
    </section>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h2 className="font-[var(--font-serif)] text-xl">{title}</h2>
      <p className="text-sm text-[var(--muted)]">{subtitle}</p>
    </header>
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
