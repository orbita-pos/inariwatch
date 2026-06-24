/**
 * Settings → Notifications (2026-05-08 design pivot, Frame 1B literal match).
 *
 * Three groups: System notifications, Quiet hours, Channels. Mirrors
 * the comp 1:1. Channels group renders a read-only summary of the
 * paired delivery targets — managing them lives in Settings →
 * Channels (deeplink at the bottom).
 */

import { ArrowRight, KeyRound } from "lucide-react";
import type { ReactNode } from "react";

import { useSettings } from "@/lib/store/settings";

import {
  Dropdown,
  Segmented,
  SettingsField,
  SettingsGroup,
  SettingsHeader,
  TextInput,
  Toggle,
} from "./primitives";

const LEVEL_OPTIONS = [
  { value: "silent", label: "Critical only" },
  { value: "important", label: "Critical and warning" },
  { value: "all", label: "All events" },
] as const;

const SOUND_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "subtle", label: "Subtle" },
  { value: "standard", label: "Standard" },
] as const;

type SoundChoice = (typeof SOUND_OPTIONS)[number]["value"];

function volumeToSound(volume: number): SoundChoice {
  if (volume <= 0) return "off";
  if (volume < 60) return "subtle";
  return "standard";
}

function soundToVolume(choice: SoundChoice, current: number): number {
  if (choice === "off") return 0;
  if (choice === "subtle") return 35;
  if (choice === "standard") return 80;
  return current;
}

export function SettingsNotifications() {
  const notifications = useSettings((s) => s.notifications);
  const patchNotifications = useSettings((s) => s.patchNotifications);

  const enabled = notifications.notification_level !== "silent" || notifications.sound_volume > 0;
  const soundChoice = volumeToSound(notifications.sound_volume);
  const quietActive = !!(notifications.quiet_hours_start && notifications.quiet_hours_end);

  return (
    <section data-testid="settings-section-notifications" className="flex flex-col">
      <SettingsHeader
        title="Notifications"
        description="OS banners, sound, and quiet-hours windows."
      />

      <div className="mt-6" />

      <SettingsGroup eyebrow="System notifications">
        <SettingsField
          first
          label="Enable OS notifications"
          control={
            <Toggle
              testId="notif-enabled-toggle"
              ariaLabel="Enable notifications"
              on={enabled}
              onChange={(v) => {
                if (!v) {
                  patchNotifications({ notification_level: "silent", sound_volume: 0 });
                } else if (notifications.notification_level === "silent") {
                  patchNotifications({ notification_level: "important", sound_volume: 35 });
                }
              }}
            />
          }
        />
        <SettingsField
          label="Sound"
          control={
            <Segmented<SoundChoice>
              testId="notif-sound-segmented"
              options={SOUND_OPTIONS}
              value={soundChoice}
              onChange={(next) =>
                patchNotifications({
                  sound_volume: soundToVolume(next, notifications.sound_volume),
                })
              }
              disabled={!enabled}
            />
          }
        />
        <SettingsField
          label="Show for"
          control={
            <Dropdown
              testId="notif-level-dropdown"
              options={LEVEL_OPTIONS}
              value={notifications.notification_level}
              onChange={(next) => patchNotifications({ notification_level: next })}
              disabled={!enabled}
              minWidth={200}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        eyebrow="Quiet hours"
        description="Suppress all notifications during a recurring window."
      >
        <SettingsField
          first
          label="Mute during quiet hours"
          control={
            <Toggle
              testId="notif-quiet-toggle"
              ariaLabel="Mute during quiet hours"
              on={quietActive}
              onChange={(v) => {
                if (!v) {
                  patchNotifications({ quiet_hours_start: "", quiet_hours_end: "" });
                } else if (!quietActive) {
                  patchNotifications({ quiet_hours_start: "22:00", quiet_hours_end: "08:00" });
                }
              }}
            />
          }
        />
        <SettingsField
          label="Window"
          helper="Daily recurring, device local time."
          control={
            <div
              className="flex items-center gap-1.5"
              style={{ opacity: quietActive ? 1 : 0.4 }}
            >
              <TextInput
                type="time"
                testId="notif-quiet-start"
                value={notifications.quiet_hours_start || "22:00"}
                onChange={(v) => patchNotifications({ quiet_hours_start: v })}
                disabled={!quietActive}
                width={88}
              />
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>→</span>
              <TextInput
                type="time"
                testId="notif-quiet-end"
                value={notifications.quiet_hours_end || "08:00"}
                onChange={(v) => patchNotifications({ quiet_hours_end: v })}
                disabled={!quietActive}
                width={88}
              />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup
        eyebrow="Channels"
        description="Active notification channels paired in this workspace."
      >
        <ChannelRow
          icon={<span style={{ fontSize: 14 }}>📱</span>}
          label="Telegram · @oncall-web"
          witnessHash="w_3a1c8e9"
          first
        />
        <ChannelRow
          icon={<span style={{ fontSize: 14 }}>📧</span>}
          label="Email · jesus@inariwatch.com"
        />
        <ChannelRow
          icon={<span style={{ fontSize: 14 }}>📞</span>}
          label="PagerDuty · oncall-web"
        />
        <a
          href="#channels"
          onClick={(e) => e.preventDefault()}
          className="inline-flex items-center gap-1 mt-2.5 text-[12px] hover:opacity-80 transition-opacity"
          style={{ color: "var(--verified)", textDecoration: "none" }}
        >
          Manage in Settings → Channels
          <ArrowRight size={11} strokeWidth={1.7} />
        </a>
      </SettingsGroup>
    </section>
  );
}

interface ChannelRowProps {
  icon: ReactNode;
  label: string;
  witnessHash?: string;
  first?: boolean;
}

function ChannelRow({ icon, label, witnessHash, first }: ChannelRowProps) {
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: "9px 0",
        borderTop: first ? "none" : "1px solid var(--border)",
      }}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>
      </div>
      {witnessHash ? (
        <span
          className="inline-flex items-center gap-1.5"
          style={{
            height: 22,
            padding: "0 8px 0 7px",
            borderRadius: 999,
            background:
              "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
            border: "1px solid rgba(166,194,176,0.18)",
            color: "var(--verified)",
            fontSize: 10.5,
            lineHeight: 1,
          }}
        >
          <KeyRound size={11} strokeWidth={1.6} />
          <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
          <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: "#C8DDD0",
              letterSpacing: "0.01em",
            }}
          >
            {witnessHash}
          </span>
        </span>
      ) : null}
    </div>
  );
}
