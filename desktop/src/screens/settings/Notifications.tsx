import { Switch } from "@/components/ui";
import { useSettings } from "@/lib/store/settings";

const LEVELS = [
  { value: "silent", label: "Silent" },
  { value: "important", label: "Important only" },
  { value: "all", label: "All" },
] as const;

export function SettingsNotifications() {
  const notifications = useSettings((s) => s.notifications);
  const patchNotifications = useSettings((s) => s.patchNotifications);

  return (
    <section data-testid="settings-section-notifications" className="flex flex-col gap-5 max-w-xl">
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">Notifications</h2>
        <p className="text-sm text-[var(--muted)]">
          When Inari should interrupt you, and how loudly.
        </p>
      </header>

      <Field label="Notification level">
        <div className="flex gap-2" role="radiogroup" aria-label="Notification level">
          {LEVELS.map((lvl) => (
            <button
              key={lvl.value}
              type="button"
              role="radio"
              aria-checked={notifications.notification_level === lvl.value}
              onClick={() => patchNotifications({ notification_level: lvl.value })}
              data-testid={`notif-level-${lvl.value}`}
              className={[
                "px-3 h-8 text-sm rounded-[var(--radius-sm)] border",
                notifications.notification_level === lvl.value
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {lvl.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label={`Volume — ${notifications.sound_volume}`}>
        <input
          type="range"
          min={0}
          max={100}
          value={notifications.sound_volume}
          onChange={(e) =>
            patchNotifications({ sound_volume: Number(e.target.value) })
          }
          data-testid="notif-volume"
          className="w-48"
        />
      </Field>

      <Field label="Quiet hours" hint="Inari stays silent during this window.">
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={notifications.quiet_hours_start}
            onChange={(e) =>
              patchNotifications({ quiet_hours_start: e.target.value })
            }
            data-testid="quiet-start"
            className="h-8 px-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] text-xs"
          />
          <span className="text-xs text-[var(--muted)]">to</span>
          <input
            type="time"
            value={notifications.quiet_hours_end}
            onChange={(e) =>
              patchNotifications({ quiet_hours_end: e.target.value })
            }
            data-testid="quiet-end"
            className="h-8 px-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] text-xs"
          />
        </div>
      </Field>

      <Field label="Respect macOS Focus Mode">
        <Switch
          checked={notifications.respect_focus_mode}
          onCheckedChange={(v) =>
            patchNotifications({ respect_focus_mode: v })
          }
          data-testid="notif-respect-focus"
          aria-label="Respect Focus Mode"
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
