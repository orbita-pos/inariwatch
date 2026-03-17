"use client";

import { useState, useTransition } from "react";
import { Sparkles, Trash2, Eye, EyeOff, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveAIKey, deleteAIKey, saveModelPreferences } from "./ai-key-actions";
import {
  TASK_LABELS, CLAUDE_MODELS, OPENAI_MODELS, GROK_MODELS, DEEPSEEK_MODELS, GEMINI_MODELS,
  DEFAULT_MODEL_PREFS,
  type AITask, type AIModelPreferences, type ModelInfo,
} from "@/lib/ai/models";
import type { AIProvider } from "@/lib/ai/client";

interface Props {
  hasKey: boolean;
  provider: string | null;
  modelPrefs: Record<string, string> | null;
}

const TASKS: AITask[] = ["analysis", "chat", "remediation", "postmortem"];

const PROVIDER_LABELS: Record<string, string> = {
  claude:   "Claude (Anthropic)",
  openai:   "OpenAI",
  grok:     "Grok (xAI)",
  deepseek: "DeepSeek",
  gemini:   "Gemini (Google)",
};

function getModels(provider: string | null): ModelInfo[] {
  switch (provider) {
    case "claude":   return CLAUDE_MODELS;
    case "grok":     return GROK_MODELS;
    case "deepseek": return DEEPSEEK_MODELS;
    case "gemini":   return GEMINI_MODELS;
    default:         return OPENAI_MODELS;
  }
}

function getDefaultLabel(task: AITask, provider: string | null): string {
  const defaults: Record<string, Record<AITask, string>> = {
    claude:   { analysis: "Haiku",        chat: "Sonnet",    remediation: "Sonnet",    postmortem: "Sonnet" },
    openai:   { analysis: "GPT-4o mini",  chat: "GPT-4o",    remediation: "GPT-4o",    postmortem: "GPT-4o" },
    grok:     { analysis: "Grok 2 Mini",  chat: "Grok 2",    remediation: "Grok 2",    postmortem: "Grok 2" },
    deepseek: { analysis: "DeepSeek V3",  chat: "DeepSeek V3", remediation: "DeepSeek R1", postmortem: "DeepSeek V3" },
    gemini:   { analysis: "Flash 1.5",    chat: "Flash 1.5", remediation: "Pro 1.5",   postmortem: "Pro 1.5" },
  };
  return defaults[provider ?? "openai"]?.[task] ?? "Auto";
}

/** Detect provider from key prefix. Returns null if genuinely ambiguous (sk- without ant-). */
function detectKeyProvider(key: string): AIProvider | "ambiguous" | null {
  if (key.startsWith("sk-ant-")) return "claude";
  if (key.startsWith("xai-"))    return "grok";
  if (key.startsWith("AIza"))    return "gemini";
  if (key.startsWith("sk-"))     return "ambiguous"; // openai or deepseek
  if (key.length > 3)            return null; // unrecognized
  return null;
}

export function AIKeySection({ hasKey, provider, modelPrefs }: Props) {
  const [showForm, setShowForm] = useState(!hasKey);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [isPending, start] = useTransition();

  // For ambiguous sk- keys (OpenAI vs DeepSeek)
  const [ambiguousProvider, setAmbiguousProvider] = useState<"openai" | "deepseek">("openai");

  // Model preferences local state
  const [prefs, setPrefs] = useState<AIModelPreferences>(() => ({
    ...DEFAULT_MODEL_PREFS,
    ...modelPrefs,
  }));
  const [modelSaved, setModelSaved] = useState(false);

  const detectedProvider = detectKeyProvider(key);

  const handleSave = () => {
    if (!key.trim()) return;
    setError("");
    start(async () => {
      const hint = detectedProvider === "ambiguous" ? ambiguousProvider : undefined;
      const result = await saveAIKey(key.trim(), hint);
      if (result?.error) {
        setError(result.error);
      } else {
        setKey("");
        setShowForm(false);
      }
    });
  };

  const handleDelete = () => {
    start(async () => {
      await deleteAIKey();
      setShowForm(true);
    });
  };

  const handleModelChange = (task: AITask, model: string) => {
    setPrefs((prev) => ({ ...prev, [task]: model }));
    setModelSaved(false);
  };

  const handleSaveModels = () => {
    start(async () => {
      const result = await saveModelPreferences(prefs);
      if (result?.error) {
        setError(result.error);
      } else {
        setModelSaved(true);
        setTimeout(() => setModelSaved(false), 2000);
      }
    });
  };

  // ── Key connected state ─────────────────────────────────────────────────

  if (hasKey && !showForm) {
    const models = getModels(provider);

    return (
      <div className="space-y-0 divide-y divide-line-subtle">
        {/* Key status */}
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-surface-dim">
              <Sparkles className="h-4 w-4 text-inari-accent" />
            </div>
            <div>
              <p className="text-sm font-medium text-fg-base">
                {PROVIDER_LABELS[provider ?? ""] ?? provider} key connected
              </p>
              <p className="text-xs text-zinc-600">
                AI analysis and correlation are active
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
              Replace
            </Button>
            <button
              onClick={handleDelete}
              disabled={isPending}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors"
              title="Remove AI key"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Model preferences */}
        <div className="py-4 space-y-4">
          <div>
            <p className="text-sm font-medium text-fg-base">Model per feature</p>
            <p className="mt-0.5 text-xs text-zinc-600">
              Each feature uses a smart default. Override to control cost vs. quality.
            </p>
          </div>

          <div className="space-y-2">
            {TASKS.map((task) => {
              const info = TASK_LABELS[task];
              const current = prefs[task] ?? "auto";
              return (
                <div key={task} className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-inner px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-fg-base">{info.label}</p>
                    <p className="text-[11px] text-zinc-600">{info.desc}</p>
                  </div>
                  <div className="relative shrink-0">
                    <select
                      value={current}
                      onChange={(e) => handleModelChange(task, e.target.value)}
                      className="appearance-none rounded-md border border-line-medium bg-surface-dim pl-2.5 pr-7 py-1.5 text-xs font-medium text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors cursor-pointer"
                    >
                      <option value="auto">Auto ({getDefaultLabel(task, provider)})</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} — {m.desc}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500 pointer-events-none" />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveModels}
              disabled={isPending}
            >
              {isPending ? "Saving…" : modelSaved ? "Saved ✓" : "Save preferences"}
            </Button>
            {error && <p className="text-xs text-red-400 font-mono">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── Key input state ─────────────────────────────────────────────────────

  return (
    <div className="space-y-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-surface-dim mt-0.5">
          <Sparkles className="h-4 w-4 text-zinc-600" />
        </div>
        <div>
          <p className="text-sm font-medium text-fg-base">AI analysis key</p>
          <p className="mt-0.5 text-xs text-zinc-600">
            Paste a key from Claude (<span className="font-mono">sk-ant-…</span>), OpenAI (
            <span className="font-mono">sk-…</span>), Grok (<span className="font-mono">xai-…</span>),
            DeepSeek (<span className="font-mono">sk-…</span>), or Gemini (
            <span className="font-mono">AIza…</span>). Stored securely and never shared.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-… / sk-… / xai-… / AIza…"
            className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 pr-10 font-mono text-sm text-fg-base placeholder-zinc-400 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        {key.length > 0 && (
          <div className="space-y-1.5">
            {detectedProvider && detectedProvider !== "ambiguous" ? (
              <p className="text-xs text-green-500">
                ✓ Detected: {PROVIDER_LABELS[detectedProvider]}
              </p>
            ) : detectedProvider === "ambiguous" ? (
              <div className="flex items-center gap-2">
                <p className="text-xs text-zinc-500">Which provider?</p>
                <div className="flex gap-1">
                  {(["openai", "deepseek"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setAmbiguousProvider(p)}
                      className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                        ambiguousProvider === p
                          ? "bg-inari-accent text-white"
                          : "bg-surface-dim text-zinc-500 border border-line-medium hover:text-fg-base"
                      }`}
                    >
                      {PROVIDER_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-amber-500">Unrecognized key format</p>
            )}
          </div>
        )}

        {error && (
          <p className="text-xs text-red-400 font-mono">{error}</p>
        )}
      </div>

      <div className="flex gap-2">
        {hasKey && (
          <Button variant="outline" size="sm" onClick={() => { setShowForm(false); setKey(""); setError(""); }}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={isPending || !key.trim() || !detectedProvider}
        >
          {isPending ? "Saving…" : "Save key"}
        </Button>
      </div>
    </div>
  );
}
