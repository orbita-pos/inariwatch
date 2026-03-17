/**
 * AI Model catalog and smart defaults.
 *
 * Each AI feature has a sensible default model that balances
 * cost vs. quality. Users can override per-task in Settings.
 */

import type { AIProvider } from "./client";

// ── Task types ──────────────────────────────────────────────────────────────

export type AITask = "analysis" | "chat" | "remediation" | "postmortem";

export type AIModelPreferences = Record<AITask, string>;

// ── Model catalog ───────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  label: string;
  desc: string;
  tier: "fast" | "balanced" | "powerful";
}

export const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku",  desc: "Fast & cheap",         tier: "fast" },
  { id: "claude-sonnet-4-6",         label: "Sonnet", desc: "Balanced",             tier: "balanced" },
  { id: "claude-opus-4-6",           label: "Opus",   desc: "Most capable, costly", tier: "powerful" },
];

export const OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-4o-mini", label: "GPT-4o mini", desc: "Fast & cheap",         tier: "fast" },
  { id: "gpt-4o",      label: "GPT-4o",      desc: "Balanced",             tier: "balanced" },
  { id: "o1-mini",     label: "o1 mini",     desc: "Most capable, costly", tier: "powerful" },
];

export const GROK_MODELS: ModelInfo[] = [
  { id: "grok-2-mini-1212", label: "Grok 2 Mini", desc: "Fast & cheap",   tier: "fast" },
  { id: "grok-2-1212",      label: "Grok 2",      desc: "Balanced",       tier: "balanced" },
  { id: "grok-3-beta",      label: "Grok 3",      desc: "Most capable",   tier: "powerful" },
];

export const DEEPSEEK_MODELS: ModelInfo[] = [
  { id: "deepseek-chat",     label: "DeepSeek V3", desc: "Fast & capable", tier: "balanced" },
  { id: "deepseek-reasoner", label: "DeepSeek R1", desc: "Deep reasoning", tier: "powerful" },
];

export const GEMINI_MODELS: ModelInfo[] = [
  { id: "gemini-1.5-flash", label: "Flash 1.5",  desc: "Fast & cheap",    tier: "fast" },
  { id: "gemini-1.5-pro",   label: "Pro 1.5",    desc: "Balanced",        tier: "balanced" },
  { id: "gemini-2.0-flash", label: "Flash 2.0",  desc: "Latest & fast",   tier: "powerful" },
];

export function getModelsForProvider(provider: AIProvider): ModelInfo[] {
  switch (provider) {
    case "claude":   return CLAUDE_MODELS;
    case "grok":     return GROK_MODELS;
    case "deepseek": return DEEPSEEK_MODELS;
    case "gemini":   return GEMINI_MODELS;
    default:         return OPENAI_MODELS;
  }
}

// ── Smart defaults per task ─────────────────────────────────────────────────

const DEFAULTS: Record<AIProvider, Record<AITask, string>> = {
  claude: {
    analysis:    "claude-haiku-4-5-20251001",
    chat:        "claude-sonnet-4-6",
    remediation: "claude-sonnet-4-6",
    postmortem:  "claude-sonnet-4-6",
  },
  openai: {
    analysis:    "gpt-4o-mini",
    chat:        "gpt-4o",
    remediation: "gpt-4o",
    postmortem:  "gpt-4o",
  },
  grok: {
    analysis:    "grok-2-mini-1212",
    chat:        "grok-2-1212",
    remediation: "grok-2-1212",
    postmortem:  "grok-2-1212",
  },
  deepseek: {
    analysis:    "deepseek-chat",
    chat:        "deepseek-chat",
    remediation: "deepseek-reasoner",
    postmortem:  "deepseek-chat",
  },
  gemini: {
    analysis:    "gemini-1.5-flash",
    chat:        "gemini-1.5-flash",
    remediation: "gemini-1.5-pro",
    postmortem:  "gemini-1.5-pro",
  },
};

/**
 * Resolve the model to use for a given task.
 * Priority: user preference → smart default for task/provider.
 * "auto" or missing = use smart default.
 */
export function resolveModel(
  task: AITask,
  provider: AIProvider,
  preferences?: AIModelPreferences | null,
): string {
  const pref = preferences?.[task];
  if (pref && pref !== "auto") return pref;
  return DEFAULTS[provider]?.[task] ?? DEFAULTS.openai[task];
}

/** Default preferences object (all "auto") */
export const DEFAULT_MODEL_PREFS: AIModelPreferences = {
  analysis: "auto",
  chat: "auto",
  remediation: "auto",
  postmortem: "auto",
};

/** Human-readable task labels */
export const TASK_LABELS: Record<AITask, { label: string; desc: string }> = {
  analysis:    { label: "Alert analysis",  desc: "Root cause summary when you click Analyze" },
  chat:        { label: "Ask Inari",       desc: "Interactive chat about your alerts & systems" },
  remediation: { label: "AI Remediation",  desc: "Code fixes, PRs, and CI checks" },
  postmortem:  { label: "Post-mortem",     desc: "Incident documentation after resolution" },
};
