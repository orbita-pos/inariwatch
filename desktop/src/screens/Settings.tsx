import { useEffect } from "react";

import { ScrollArea } from "@/components/ui";
import { useSettings, type SettingsSection } from "@/lib/store/settings";
import { SettingsAbout } from "@/screens/settings/About";
import { SettingsAccount } from "@/screens/settings/Account";
import { SettingsAi } from "@/screens/settings/AI";
import { SettingsGeneral } from "@/screens/settings/General";
import { SettingsNotifications } from "@/screens/settings/Notifications";
import { SettingsPrivacy } from "@/screens/settings/Privacy";
import { SettingsRepos } from "@/screens/settings/Repos";
import { SettingsSensors } from "@/screens/settings/Sensors";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general",       label: "General"       },
  { id: "repos",         label: "Repos"         },
  { id: "sensors",       label: "Sensors"       },
  { id: "notifications", label: "Notifications" },
  { id: "ai",            label: "AI"            },
  { id: "privacy",       label: "Privacy"       },
  { id: "about",         label: "About"         },
  { id: "account",       label: "Account"       },
];

/**
 * Settings shell — left rail with sections, right pane with the active
 * section's component. The active section lives in `useSettings.activeSection`
 * so a deep-link via `inari://navigate` (Sesión 14) can pivot it.
 */
export function Settings() {
  const activeSection = useSettings((s) => s.activeSection);
  const setActiveSection = useSettings((s) => s.setActiveSection);
  const loadAll = useSettings((s) => s.loadAll);
  const loaded = useSettings((s) => s.loaded);

  useEffect(() => {
    if (!loaded) void loadAll();
  }, [loaded, loadAll]);

  return (
    <div data-testid="settings-shell" className="h-full w-full flex">
      <nav
        data-testid="settings-rail"
        aria-label="Settings sections"
        className="w-[200px] shrink-0 h-full border-r border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-1"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setActiveSection(s.id)}
            data-testid={`settings-tab-${s.id}`}
            aria-current={activeSection === s.id ? "page" : undefined}
            className={[
              "h-8 px-2 rounded-[var(--radius-sm)] text-sm text-left transition-colors",
              activeSection === s.id
                ? "bg-[var(--bg)] text-[var(--text)] shadow-[var(--shadow-1)]"
                : "text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]",
            ].join(" ")}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <ScrollArea className="flex-1 h-full">
        <main className="p-8">
          {activeSection === "general"       ? <SettingsGeneral /> : null}
          {activeSection === "repos"         ? <SettingsRepos /> : null}
          {activeSection === "sensors"       ? <SettingsSensors /> : null}
          {activeSection === "notifications" ? <SettingsNotifications /> : null}
          {activeSection === "ai"            ? <SettingsAi /> : null}
          {activeSection === "privacy"       ? <SettingsPrivacy /> : null}
          {activeSection === "about"         ? <SettingsAbout /> : null}
          {activeSection === "account"       ? <SettingsAccount /> : null}
        </main>
      </ScrollArea>
    </div>
  );
}
