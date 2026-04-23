/**
 * AI Model catalog and smart defaults.
 *
 * Each AI feature has a sensible default model that balances
 * cost vs. quality. Users can override per-task in Settings.
 */

import type { AIProvider } from "./client";

// ── Task types ──────────────────────────────────────────────────────────────

export type AITask = "analysis" | "chat" | "remediation" | "postmortem" | "triage";

export type AIModelPreferences = Record<AITask, string> & { activeProvider?: string };

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
  { id: "gpt-4o-mini",  label: "GPT-4o mini",  desc: "Fast & cheap ($0.15/$0.60 per M)",       tier: "fast" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", desc: "1M context, balanced ($0.40/$1.60)",     tier: "balanced" },
  // Fase 3 — gpt-5-nano is the cheapest reasoning model in the GPT-5 family;
  // catalog only for now. Fase 6 wires it into the tier router (ADR-006).
  { id: "gpt-5-nano",   label: "GPT-5 nano",   desc: "Cheapest reasoning, for routing/triage ($0.05/$0.40)", tier: "fast" },
  { id: "gpt-5-mini",   label: "GPT-5 mini",   desc: "Reasoning, cheap ($0.25/$2.00)",          tier: "balanced" },
  { id: "gpt-5.4",      label: "GPT-5.4",      desc: "Flagship, best for code ($1.25/$10)",     tier: "powerful" },
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

export const GROQ_MODELS: ModelInfo[] = [
  { id: "llama-3.1-70b-versatile", label: "Llama 3.1 70B", desc: "Fast & capable", tier: "balanced" },
  { id: "llama-3.1-8b-instant",    label: "Llama 3.1 8B",  desc: "Ultra-fast",     tier: "fast" },
  { id: "mixtral-8x7b-32768",      label: "Mixtral 8x7B",  desc: "MoE balanced",   tier: "balanced" },
];

export function getModelsForProvider(provider: AIProvider): ModelInfo[] {
  switch (provider) {
    case "claude":   return CLAUDE_MODELS;
    case "grok":     return GROK_MODELS;
    case "groq":     return GROQ_MODELS;
    case "deepseek": return DEEPSEEK_MODELS;
    case "gemini":   return GEMINI_MODELS;
    default:         return OPENAI_MODELS;
  }
}

// ── Smart defaults per task ─────────────────────────────────────────────────

const DEFAULTS: Record<AIProvider, Record<AITask, string>> = {
  claude: {
    analysis:    "claude-haiku-4-5-20251001",
    triage:      "claude-haiku-4-5-20251001",
    chat:        "claude-sonnet-4-6",
    remediation: "claude-sonnet-4-6",
    postmortem:  "claude-sonnet-4-6",
  },
  openai: {
    analysis:    "gpt-4o-mini",   // Classification + summarization — 87% cheaper than Haiku 4.5
    triage:      "gpt-4o-mini",   // Alert triage — cheapest possible, ~$0.0001/call
    chat:        "gpt-4o-mini",   // Conversational — GPT-4o-mini handles tool use well
    remediation: "gpt-5.4",       // Code fixes — tied with Sonnet on SWE-bench (~80%), ~40% cheaper
    postmortem:  "gpt-5-mini",    // Long-form writing with reasoning — $0.25/$2.00
  },
  grok: {
    analysis:    "grok-2-mini-1212",
    triage:      "grok-2-mini-1212",
    chat:        "grok-2-1212",
    remediation: "grok-2-1212",
    postmortem:  "grok-2-1212",
  },
  deepseek: {
    analysis:    "deepseek-chat",
    triage:      "deepseek-chat",
    chat:        "deepseek-chat",
    remediation: "deepseek-reasoner",
    postmortem:  "deepseek-chat",
  },
  gemini: {
    analysis:    "gemini-1.5-flash",
    triage:      "gemini-1.5-flash",
    chat:        "gemini-1.5-flash",
    remediation: "gemini-1.5-pro",
    postmortem:  "gemini-1.5-pro",
  },
  groq: {
    analysis:    "llama-3.1-70b-versatile",
    triage:      "llama-3.1-8b-instant",  // Ultra-fast, cheapest — perfect for classification
    chat:        "llama-3.1-70b-versatile",
    remediation: "llama-3.1-70b-versatile",
    postmortem:  "llama-3.1-70b-versatile",
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

// ── Fase 3 — Phase-aware model routing ──────────────────────────────────────
//
// The remediation loop runs in two distinct phases:
//
//   • "explore" — the agent is searching, reading, and reasoning about the
//     bug. A cheap reasoning model (gpt-5-mini, low effort) is enough here;
//     burning gpt-5.4 reasoning tokens to decide which file to grep next
//     is wasteful.
//
//   • "fix" — the agent has located the bug and is producing the patch.
//     Quality of output matters here, so the flagship (gpt-5.4) does the
//     work. The last few turns ("final") bump reasoning to high to give
//     the model room to correct tsc/build errors before the turn cap.
//
// Two pre-remediation phases map to the cheapest reasoning tier:
//
//   • "classify"  — tier router classifier (Fase 6). gpt-5-nano.
//   • "triage"    — alert triage / auto-analyze / correlate. gpt-5-mini.
//
// Other providers don't have a native "nano" tier yet; for those we fall
// back to whatever that provider uses for `triage` today. The mapping is
// intentionally conservative — only OpenAI gets the full Fase 3 treatment.
// The rest of the providers keep their existing defaults so BYOK users
// experience no behavior change.

export type RemediationPhase = "classify" | "triage" | "explore" | "fix" | "final";

const PHASE_MODELS_OPENAI: Record<RemediationPhase, string> = {
  // Catalog only in Fase 3 — Fase 6 wires it into the tier router.
  classify: "gpt-5-nano",
  triage:   "gpt-5-mini",
  explore:  "gpt-5-mini",
  fix:      "gpt-5.4",
  final:    "gpt-5.4",
};

/**
 * Resolve the model to use for a specific phase of the remediation loop.
 * Only OpenAI has phase-specialized models today (the others keep their
 * existing `triage` / `remediation` defaults). Callers that don't care
 * about the phase should keep using `resolveModel(task, provider, prefs)`.
 *
 * Fase 3: called from worker/container-agent once REMEDIATION_MODEL_ROUTING
 * is on. When the flag is off, `remediate.ts` keeps passing the single
 * remediation model it always did.
 */
export function resolveModelForPhase(
  phase: RemediationPhase,
  provider: AIProvider,
): string {
  if (provider === "openai") return PHASE_MODELS_OPENAI[phase];

  const defaults = DEFAULTS[provider];
  if (!defaults) return DEFAULTS.openai.remediation;

  switch (phase) {
    case "classify":
    case "triage":
      return defaults.triage;
    case "explore":
      return defaults.analysis;
    case "fix":
    case "final":
      return defaults.remediation;
  }
}

/** Default preferences object (all "auto") */
export const DEFAULT_MODEL_PREFS: AIModelPreferences = {
  analysis: "auto",
  triage: "auto",
  chat: "auto",
  remediation: "auto",
  postmortem: "auto",
};

/** Human-readable task labels */
export const TASK_LABELS: Record<AITask, { label: string; desc: string }> = {
  analysis:    { label: "Alert analysis",  desc: "Root cause summary when you click Analyze" },
  triage:      { label: "Alert triage",    desc: "Quick classification to route alerts efficiently" },
  chat:        { label: "Ask Inari",       desc: "Interactive chat about your alerts & systems" },
  remediation: { label: "AI Remediation",  desc: "Code fixes, PRs, and CI checks" },
  postmortem:  { label: "Post-mortem",     desc: "Incident documentation after resolution" },
};
