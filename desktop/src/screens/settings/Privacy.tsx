/**
 * Settings → Privacy (2026-05-08 design pivot, Frame 1C literal match).
 *
 * Three groups + danger zone box:
 *
 *   1. Telemetry — single anonymous-usage toggle.
 *   2. Local data — kv summary + Compact / Export ghost buttons.
 *   3. Crash reports — single toggle.
 *   4. Danger zone — destructive ghost-red button on the LEFT,
 *      helper text running to the RIGHT (not below).
 */

import { useSettings } from "@/lib/store/settings";

import {
  GhostButton,
  KvRow,
  SettingsField,
  SettingsGroup,
  SettingsHeader,
  Toggle,
} from "./primitives";

export function SettingsPrivacy() {
  const privacy = useSettings((s) => s.privacy);
  const patchPrivacy = useSettings((s) => s.patchPrivacy);

  return (
    <section data-testid="settings-section-privacy" className="flex flex-col">
      <SettingsHeader
        title="Privacy"
        description="What leaves this machine and what stays local."
      />

      <div className="mt-6" />

      <SettingsGroup eyebrow="Telemetry">
        <SettingsField
          first
          label="Anonymous usage telemetry"
          helper={
            <>
              No prompts, no code, no receipts.{" "}
              <a
                className="hover:opacity-80 transition-opacity"
                style={{ color: "var(--verified)", textDecoration: "none" }}
                href="#what-is-collected"
                onClick={(e) => e.preventDefault()}
              >
                What's collected →
              </a>
            </>
          }
          control={
            <Toggle
              testId="privacy-telemetry-toggle"
              ariaLabel="Anonymous usage telemetry"
              on={!privacy.telemetry_optout}
              onChange={(v) => patchPrivacy({ telemetry_optout: !v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Local data">
        <KvRow k="audit log size" v="1.4 GB" mono />
        <KvRow k="witness chain depth" v="4187" mono />
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <GhostButton testId="privacy-compact-audit">Compact audit log</GhostButton>
          <GhostButton testId="privacy-export-chain">Export receipt chain</GhostButton>
        </div>
      </SettingsGroup>

      <SettingsGroup eyebrow="Crash reports">
        <SettingsField
          first
          label="Send anonymized crash logs"
          helper={
            <>
              Stripped of all user content. View in{" "}
              <a
                className="hover:opacity-80 transition-opacity"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-subtle)",
                  textDecoration: "none",
                }}
                href="#inari-logs"
                onClick={(e) => e.preventDefault()}
              >
                inari logs
              </a>
              .
            </>
          }
          control={
            <Toggle
              testId="privacy-crash-toggle"
              ariaLabel="Crash logs"
              on={false}
              onChange={() => {
                /* TODO: wire crash-log opt-in */
              }}
            />
          }
        />
      </SettingsGroup>

      {/* Danger zone — full box per the comp, helper runs to the right
       * of the destructive button (not below). */}
      <div
        className="mt-5 p-4"
        style={{
          background: "rgba(208,133,133,0.03)",
          border: "1px solid rgba(208,133,133,0.28)",
          borderRadius: 9,
        }}
      >
        <div
          className="text-[11px] font-medium"
          style={{
            color: "var(--danger)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Danger zone
        </div>
        <div className="flex items-start gap-3 flex-wrap">
          <GhostButton testId="privacy-reset-all" destructive>
            Delete all local data and reset Inari Live
          </GhostButton>
          <span
            className="text-[11.5px]"
            style={{
              color: "var(--text-subtle)",
              lineHeight: 1.4,
              maxWidth: 300,
              alignSelf: "center",
            }}
          >
            Permanently erases the audit log, receipt chain, and all settings.
            Cannot be undone.
          </span>
        </div>
      </div>
    </section>
  );
}
