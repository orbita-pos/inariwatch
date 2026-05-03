import { useEffect } from "react";

import { ScrollArea, TopBar } from "@/components/ui";
import { useSettings, type SettingsSection } from "@/lib/store/settings";
import { SettingsAbout } from "@/screens/settings/About";
import { SettingsAccount } from "@/screens/settings/Account";
import { SettingsAi } from "@/screens/settings/AI";
import { SettingsGeneral } from "@/screens/settings/General";
import { SettingsNotifications } from "@/screens/settings/Notifications";
import { SettingsPrivacy } from "@/screens/settings/Privacy";
import { SettingsRepos } from "@/screens/settings/Repos";
import { SettingsSensors } from "@/screens/settings/Sensors";
import { SettingsWhatsApp } from "@/screens/settings/WhatsApp";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general",       label: "General"       },
  { id: "repos",         label: "Repos"         },
  { id: "sensors",       label: "Sensors"       },
  { id: "notifications", label: "Notifications" },
  { id: "whatsapp",      label: "WhatsApp"      },
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
        className="w-[220px] shrink-0 h-full border-r border-[var(--border-subtle)] bg-[var(--bg)] px-2 py-3 flex flex-col gap-px"
      >
        <div className="px-2 pb-2 text-[11px] uppercase tracking-wide text-[var(--text-subtle)] font-medium">
          Settings
        </div>
        {SECTIONS.map((s) => {
          const selected = activeSection === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              data-testid={`settings-tab-${s.id}`}
              aria-current={selected ? "page" : undefined}
              className={[
                "relative h-7 px-2 rounded-[var(--radius-sm)] text-[13px] text-left",
                "transition-colors duration-[var(--duration-fast)] outline-none cursor-pointer",
                "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                selected
                  ? "bg-[var(--card)] text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--card)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {selected ? (
                <span
                  aria-hidden
                  className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r bg-[var(--accent)]"
                />
              ) : null}
              {s.label}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 h-full flex flex-col min-w-0">
        <TopBar
          testId="settings-topbar"
          title="Settings"
          meta={SECTIONS.find((s) => s.id === activeSection)?.label ?? "General"}
        />
        <ScrollArea className="flex-1">
          <main className="p-6">
            {activeSection === "general"       ? <SettingsGeneral /> : null}
            {activeSection === "repos"         ? <SettingsRepos /> : null}
            {activeSection === "sensors"       ? <SettingsSensors /> : null}
            {activeSection === "notifications" ? <SettingsNotifications /> : null}
            {activeSection === "whatsapp"      ? <SettingsWhatsApp /> : null}
            {activeSection === "ai"            ? <SettingsAi /> : null}
            {activeSection === "privacy"       ? <SettingsPrivacy /> : null}
            {activeSection === "about"         ? <SettingsAbout /> : null}
            {activeSection === "account"       ? <SettingsAccount /> : null}
          </main>
        </ScrollArea>
      </div>
    </div>
  );
}
