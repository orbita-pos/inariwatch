import {
  Activity,
  AlignLeft,
  Bell,
  Brain,
  Cog,
  Folder,
  Keyboard,
  Laptop,
  Lightbulb,
  type LucideIcon,
  Mic,
  Settings as SettingsIcon,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { useSettings, type SettingsSection } from "@/lib/store/settings";
import { SettingsAbout } from "@/screens/settings/About";
import { SettingsAccount } from "@/screens/settings/Account";
import { SettingsAi } from "@/screens/settings/AI";
import { SettingsChannels } from "@/screens/settings/Channels";
import { SettingsDevices } from "@/screens/settings/Devices";
import { SettingsGeneral } from "@/screens/settings/General";
import { SettingsNotifications } from "@/screens/settings/Notifications";
import { SettingsPermissions } from "@/screens/settings/Permissions";
import { SettingsPrivacy } from "@/screens/settings/Privacy";
import { SettingsProjects } from "@/screens/settings/Projects";
import { SettingsSensors } from "@/screens/settings/Sensors";
import { SettingsUserMemory } from "@/screens/settings/UserMemory";
import { SettingsVoice } from "@/screens/settings/Voice";

interface SectionEntry {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  /** Optional right-aligned meta (count, status). */
  meta?: ReactNode;
}

interface SectionGroup {
  items: SectionEntry[];
}

/**
 * Three rail groups, separated by hairline dividers — matches the
 * Claude Design comp:
 *   - Top: General (the catch-all)
 *   - Tools / channels / voice / messaging — the day-to-day surface
 *   - Workspace (repos / sensors)
 *   - Footer: account / privacy / about
 *
 * Twelve sections is more than the design recommends (the comp
 * proposed a consolidation to 8), but we render all 12 today so
 * existing routes / store keys stay untouched. Consolidation is
 * a tracked follow-up.
 */
function buildGroups(_state: ReturnType<typeof useSettings.getState>): SectionGroup[] {
  return [
    {
      items: [{ id: "general", label: "General", icon: AlignLeft }],
    },
    {
      items: [
        { id: "ai",            label: "AI",            icon: Lightbulb },
        { id: "memory",        label: "Memory",        icon: Brain },
        { id: "permissions",   label: "Permissions",   icon: ShieldCheck },
        { id: "channels",      label: "Channels",      icon: Keyboard },
        { id: "voice",         label: "Voice",         icon: Mic },
        { id: "notifications", label: "Notifications", icon: Bell },
      ],
    },
    {
      items: [
        { id: "sensors", label: "Sensors", icon: Activity },
      ],
    },
    {
      items: [
        { id: "devices",  label: "Devices",  icon: Laptop },
        { id: "projects", label: "Projects", icon: Folder },
        { id: "account",  label: "Account",  icon: User },
        { id: "privacy",  label: "Privacy",  icon: ShieldCheck },
        { id: "about",    label: "About",    icon: Cog },
      ],
    },
  ];
}

const SECTION_LABELS: Record<SettingsSection, string> = {
  general:       "General",
  sensors:       "Sensors",
  notifications: "Notifications",
  voice:         "Voice",
  channels:      "Channels",
  ai:            "AI",
  memory:        "Memory",
  permissions:   "Permissions",
  privacy:       "Privacy",
  devices:       "Devices",
  projects:      "Projects",
  about:         "About",
  account:       "Account",
};

interface SettingsProps {
  /** Hook into the parent Dialog's close. Optional so the legacy full-page mount still works. */
  onClose?: () => void;
}

/**
 * Settings shell — left rail with sections, right pane with the
 * active section's component. The 2026-05-07 chat-first reframe puts
 * Settings inside a Dialog modal opened by the gear in the chat
 * titlebar; passing `onClose` from the parent wires the X / ESC
 * close path.
 */
export function Settings({ onClose }: SettingsProps = {}) {
  const state = useSettings();
  const activeSection = state.activeSection;
  const setActiveSection = state.setActiveSection;
  const loadAll = state.loadAll;
  const loaded = state.loaded;

  useEffect(() => {
    if (!loaded) void loadAll();
  }, [loaded, loadAll]);

  const groups = buildGroups(state);

  return (
    <div
      data-testid="settings-shell"
      className="h-full w-full grid"
      style={{
        gridTemplateRows: "44px 1fr",
        background: "var(--bg)",
      }}
    >
      <header
        className="flex items-center justify-between px-5"
        style={{
          borderBottom: "1px solid var(--border)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))",
        }}
      >
        <div className="flex items-center gap-2.5">
          <SettingsIcon size={13} strokeWidth={1.6} style={{ color: "var(--text-muted)" }} />
          <span
            className="text-[13.5px] font-medium tracking-[-0.005em]"
            style={{ color: "var(--text)" }}
          >
            Settings
          </span>
          <span style={{ color: "var(--text-faint)" }}>·</span>
          <span
            className="text-[12.5px]"
            style={{ color: "var(--text-subtle)" }}
            data-testid="settings-breadcrumb"
          >
            {SECTION_LABELS[activeSection] ?? "General"}
          </span>
          <span
            className="ml-2 text-[11.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
          >
            ⌘,
          </span>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="transition-colors"
            aria-label="Close settings"
            data-testid="settings-close"
            style={{ color: "var(--text-subtle)" }}
          >
            <X size={14} strokeWidth={1.7} />
          </button>
        ) : null}
      </header>

      <div className="grid min-h-0" style={{ gridTemplateColumns: "208px 1fr" }}>
        <nav
          data-testid="settings-rail"
          aria-label="Settings sections"
          className="overflow-hidden py-3.5"
          style={{
            borderRight: "1px solid var(--border)",
            background: "linear-gradient(180deg, rgba(255,255,255,0.012), rgba(255,255,255,0))",
          }}
        >
          {groups.map((group, gi) => (
            <div key={gi}>
              {gi > 0 ? (
                <div
                  className="mx-3.5 my-2"
                  style={{ height: 1, background: "var(--border)" }}
                />
              ) : null}
              <div className="px-2 pb-1.5">
                {group.items.map((entry) => {
                  const selected = activeSection === entry.id;
                  return (
                    <RailItem
                      key={entry.id}
                      entry={entry}
                      selected={selected}
                      onClick={() => setActiveSection(entry.id)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="overflow-hidden relative">
          <div className="h-full overflow-auto">
            <div className="px-8 pt-7 pb-8 max-w-[640px]">
              {activeSection === "general"       ? <SettingsGeneral /> : null}
              {activeSection === "sensors"       ? <SettingsSensors /> : null}
              {activeSection === "notifications" ? <SettingsNotifications /> : null}
              {activeSection === "voice"         ? <SettingsVoice /> : null}
              {activeSection === "channels"      ? <SettingsChannels /> : null}
              {activeSection === "ai"            ? <SettingsAi /> : null}
              {activeSection === "memory"        ? <SettingsUserMemory /> : null}
              {activeSection === "permissions"   ? <SettingsPermissions /> : null}
              {activeSection === "privacy"       ? <SettingsPrivacy /> : null}
              {activeSection === "devices"       ? <SettingsDevices /> : null}
              {activeSection === "projects"      ? <SettingsProjects /> : null}
              {activeSection === "about"         ? <SettingsAbout /> : null}
              {activeSection === "account"       ? <SettingsAccount /> : null}
            </div>
          </div>
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-7 pointer-events-none"
            style={{
              background:
                "linear-gradient(0deg, var(--bg) 0%, rgba(10,10,12,0) 100%)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

interface RailItemProps {
  entry: SectionEntry;
  selected: boolean;
  onClick: () => void;
}

function RailItem({ entry, selected, onClick }: RailItemProps) {
  const Icon = entry.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`settings-tab-${entry.id}`}
      aria-current={selected ? "page" : undefined}
      className="w-full flex items-center gap-2.5 px-2.5 transition-colors relative cursor-pointer focus:outline-none"
      style={{
        height: 30,
        borderRadius: 7,
        background: selected ? "rgba(255,255,255,0.028)" : "transparent",
        color: selected ? "var(--text)" : "var(--text-muted)",
        fontSize: 13,
        letterSpacing: "-0.005em",
      }}
      onMouseEnter={(e) => {
        if (!selected) {
          e.currentTarget.style.background = "rgba(255,255,255,0.018)";
          e.currentTarget.style.color = "var(--text)";
        }
      }}
      onMouseLeave={(e) => {
        if (!selected) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-muted)";
        }
      }}
    >
      {selected ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: -8,
            top: 6,
            bottom: 6,
            width: 2,
            background: "var(--accent)",
            borderRadius: 2,
          }}
        />
      ) : null}
      <Icon
        size={13}
        strokeWidth={1.7}
        style={{
          color: selected ? "var(--text)" : "var(--text-dim)",
          flexShrink: 0,
        }}
        aria-hidden
      />
      <span className="text-left flex-1 truncate">{entry.label}</span>
      {entry.meta ? (
        <span
          className="text-[11px] ml-auto"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}
        >
          {entry.meta}
        </span>
      ) : null}
    </button>
  );
}
