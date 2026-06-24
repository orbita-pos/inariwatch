import { useEffect, useState } from "react";

import { useSettings } from "@/lib/store/settings";

import { localAiLoad, localAiStatus } from "@/lib/main-ipc";

import {
  Dropdown,
  GhostButton,
  KvRow,
  SettingsField,
  SettingsGroup,
  SettingsHeader,
  TextInput,
  Toggle,
} from "./primitives";

const ROUTING_OPTIONS = [
  { value: "auto" as const, label: "Auto (default)" },
  { value: "always_mini" as const, label: "Always 5.4-mini · cheaper" },
  { value: "always_full" as const, label: "Always 5.4 · best" },
];

export function SettingsAi() {
  const ai = useSettings((s) => s.ai);
  const patchAi = useSettings((s) => s.patchAi);
  const [draftKey, setDraftKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [localAiStatus_, setLocalAiStatus] = useState<string>("idle");

  async function saveKey() {
    if (saving || !draftKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await patchAi({ openai_key: draftKey.trim() });
      setDraftKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    setError(null);
    await patchAi({ openai_key: "" });
  }

  async function toggleLocalChat(next: boolean) {
    await patchAi({ local_chat_enabled: next });
    if (next) {
      setLocalAiStatus("loading");
      const status = await localAiLoad();
      setLocalAiStatus(status.status);
    }
  }

  useEffect(() => {
    if (!ai.local_chat_enabled) return;
    localAiStatus().then((s) => setLocalAiStatus(s.status)).catch(() => undefined);
  }, [ai.local_chat_enabled]);

  const spendPct = ai.spend_cap_usd > 0
    ? Math.min(100, Math.round((ai.spend_today_usd / ai.spend_cap_usd) * 100))
    : 0;

  return (
    <section data-testid="settings-section-ai" className="flex flex-col">
      <SettingsHeader
        title="AI"
        description="Bring your own key or fall back to the platform key."
      />

      <div className="mt-6" />

      <SettingsGroup eyebrow="Provider keys (BYOK)" description="Stored encrypted on this workstation. Never sent to Inari.">
        {ai.byok_present ? (
          <SettingsField
            first
            label="OpenAI"
            helper={
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}>
                {ai.byok_preview || "sk-•••"}
              </span>
            }
            control={
              <GhostButton testId="ai-byok-clear" onClick={() => void clearKey()}>
                Remove
              </GhostButton>
            }
          />
        ) : null}
        <SettingsField
          first={!ai.byok_present}
          label={ai.byok_present ? "Replace key" : "OpenAI API key"}
          helper={error ? (
            <span style={{ color: "var(--danger)" }}>{error}</span>
          ) : (
            "Paste an sk-… key. Stored in your OS keychain."
          )}
          control={
            <div className="flex items-center gap-2">
              <TextInput
                value={draftKey}
                onChange={setDraftKey}
                placeholder={ai.byok_present ? "Replace key…" : "sk-…"}
                type="text"
                mono
                width={200}
                testId="ai-byok-input"
              />
              <GhostButton
                testId="ai-byok-save"
                onClick={() => void saveKey()}
              >
                {saving ? "Saving…" : "Save"}
              </GhostButton>
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Routing" description="Lets cheap models do classification, expensive ones do edits.">
        <SettingsField
          first
          label="Model routing"
          control={
            <Dropdown
              testId="ai-model-routing"
              options={ROUTING_OPTIONS}
              value={ai.model_routing}
              onChange={(next) => patchAi({ model_routing: next })}
              minWidth={240}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Spend">
        <KvRow
          k="today"
          v={
            <span data-testid="ai-spend-summary">
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                ${ai.spend_today_usd.toFixed(2)}
              </span>
              <span style={{ color: "var(--text-faint)" }}> / </span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}>
                ${ai.spend_cap_usd.toFixed(0)} daily cap
              </span>
            </span>
          }
        />
        <div
          className="mt-2"
          style={{
            height: 4,
            background: "rgba(255,255,255,0.05)",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${spendPct}%`,
              height: "100%",
              background: "var(--accent)",
              borderRadius: 999,
              transition: "width 200ms",
            }}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        eyebrow="Local AI (offline mode)"
        description="Run SmolLM2-1.7B Q4 locally — no internet, no API key. First enable downloads ~1.1 GB."
      >
        <SettingsField
          first
          label="Offline chat"
          helper={
            ai.local_chat_enabled
              ? localAiStatus_ === "ready"
                ? "Model loaded — chats run fully on-device."
                : localAiStatus_ === "loading"
                ? "Downloading model… (~1.1 GB, check console for progress)."
                : localAiStatus_ === "failed"
                ? "Load failed — check logs and try again."
                : "Toggle on to start the download."
              : "Enable to use a local model instead of the cloud API."
          }
          control={
            <Toggle
              testId="ai-local-chat-toggle"
              on={ai.local_chat_enabled}
              onChange={(next) => void toggleLocalChat(next)}
              ariaLabel="Enable local AI offline mode"
            />
          }
        />
      </SettingsGroup>
    </section>
  );
}
