import { useState } from "react";

import { Button, Input } from "@/components/ui";
import { useSettings } from "@/lib/store/settings";

const ROUTING_OPTIONS = [
  { value: "auto", label: "Auto (default)" },
  { value: "always_mini", label: "Always 5.4-mini (cheaper)" },
  { value: "always_full", label: "Always 5.4 (best)" },
] as const;

export function SettingsAi() {
  const ai = useSettings((s) => s.ai);
  const patchAi = useSettings((s) => s.patchAi);
  const [draftKey, setDraftKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function saveKey() {
    setError(null);
    try {
      await patchAi({ openai_key: draftKey.trim() });
      setDraftKey("");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    }
  }

  async function clearKey() {
    setError(null);
    await patchAi({ openai_key: "" });
  }

  return (
    <section data-testid="settings-section-ai" className="flex flex-col gap-5 max-w-xl">
      <header>
        <h2 className="font-[var(--font-serif)] text-xl">AI</h2>
        <p className="text-sm text-[var(--muted)]">
          Bring your own OpenAI key, or fall back to the platform key.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <label htmlFor="ai-byok" className="text-sm font-medium">
          OpenAI API key
        </label>
        {ai.byok_present ? (
          <div className="flex items-center gap-2">
            <code className="text-xs text-[var(--muted)] flex-1" data-testid="ai-byok-preview">
              {ai.byok_preview || "sk-***"}
            </code>
            <Button size="sm" variant="ghost" onClick={clearKey} data-testid="ai-byok-clear">
              Remove
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Input
            id="ai-byok"
            type="password"
            placeholder={ai.byok_present ? "Replace key…" : "sk-…"}
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            data-testid="ai-byok-input"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={draftKey.trim().length === 0}
            onClick={saveKey}
            data-testid="ai-byok-save"
          >
            Save
          </Button>
        </div>
        {error ? (
          <p className="text-xs text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Model routing</span>
        <select
          value={ai.model_routing}
          onChange={(e) =>
            patchAi({
              model_routing: e.target.value as
                | "auto"
                | "always_mini"
                | "always_full",
            })
          }
          data-testid="ai-model-routing"
          className="h-9 px-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] text-sm"
        >
          {ROUTING_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div
        className="flex items-center justify-between p-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
        data-testid="ai-spend-summary"
      >
        <span className="text-sm">Spend today</span>
        <span className="text-sm tabular-nums">
          ${ai.spend_today_usd.toFixed(2)} / ${ai.spend_cap_usd.toFixed(0)}
        </span>
      </div>
    </section>
  );
}
