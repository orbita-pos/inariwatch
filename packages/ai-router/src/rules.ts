// Routing rules. Per INARI_AI_ARCHITECTURE.md §6 (LOCKED 2026-05-02).
//
// PHASE 1 (S1): every task routes to cloud, behavior identical to pre-refactor.
// The router is a no-op refactor — caller-resolved apiKey + provider win.
// Local routing turns on per-task in Phase 3+ (S3 begins with notify.compose.email).
//
// Adding a new AI task: 1) define it in tasks.ts, 2) add a rule here.

import { TASKS, type TaskName } from "./tasks";

export type AIProvider =
  | "openai"
  | "claude"
  | "groq"
  | "grok"
  | "deepseek"
  | "gemini";

export type Substrate =
  | "cloud"
  | "user-sidecar"
  | "capture-embedded"
  | "cli-linked";

export type FallbackTrigger =
  | "sidecar-offline"
  | "sidecar-timeout"
  | "workspace-flag-cloud-only"
  | "cloud-error"
  | "cloud-rate-limit"
  | "cloud-budget-exceeded";

/**
 * A target describes WHERE a task runs and (optionally) WHICH provider/model.
 *
 * In Phase 1, `provider` and `model` on cloud targets are advisory hints. The
 * dispatch path always honors what the caller passes via `apiKey` + `opts.model`
 * — this is what makes the refactor zero-behavior-change. Phase 3+ rules will
 * pin provider/model and let the rule override caller intent for `notify.*`
 * etc.
 */
export type Target =
  | { substrate: "cloud"; provider?: AIProvider; model?: string }
  | { substrate: "user-sidecar"; model: string }
  | { substrate: "capture-embedded"; model: string }
  | { substrate: "cli-linked"; model: string };

export interface Rule {
  primary: Target;
  fallback?: Target;
  fallbackTriggers?: FallbackTrigger[];
}

// ── Phase-1 cloud-only rules ────────────────────────────────────────────────
//
// Every entry below points at `{ substrate: "cloud" }`. Provider/model hints
// reflect today's defaults but DO NOT override caller-supplied values in
// Phase 1.

const CLOUD: Target = { substrate: "cloud" };

const CLOUD_OPENAI: Target = { substrate: "cloud", provider: "openai" };
const CLOUD_CLAUDE: Target = { substrate: "cloud", provider: "claude" };
const CLOUD_GROQ: Target = { substrate: "cloud", provider: "groq" };

export const RULES: Record<TaskName, Rule> = {
  // 5.1 code.* — cloud only, locked. Provider hints reflect current behavior.
  [TASKS.CODE_FIX_SINGLE_SHOT]: { primary: CLOUD_OPENAI, fallback: CLOUD_CLAUDE, fallbackTriggers: ["cloud-error", "cloud-rate-limit"] },
  [TASKS.CODE_FIX_AGENT_LOOP]:  { primary: CLOUD_OPENAI, fallback: CLOUD_CLAUDE, fallbackTriggers: ["cloud-error", "cloud-rate-limit"] },
  [TASKS.CODE_REVIEW_SELF]:     { primary: CLOUD_OPENAI },
  [TASKS.CODE_REVIEW_SECURITY]: { primary: CLOUD_OPENAI },
  [TASKS.CODE_RISK_ASSESS]:     { primary: CLOUD_OPENAI },
  [TASKS.CODE_FINGERPRINT]:     { primary: CLOUD_OPENAI },

  // The three "ALREADY LOCAL" code tasks live on the desktop runtime; web
  // never calls them. The rules exist for taxonomy completeness — when
  // desktop/CLI surfaces wire up, S7 swaps these to user-sidecar/cli-linked.
  [TASKS.CODE_FIM_COMPLETION]:  { primary: CLOUD_OPENAI },
  [TASKS.CODE_APPLY_DIFF]:      { primary: CLOUD_OPENAI },
  [TASKS.CODE_EMBED]:           { primary: CLOUD_OPENAI },

  // 5.2 alert.* — hybrid eventually. Phase 1: cloud.
  [TASKS.ALERT_AUTO_ANALYZE]: { primary: CLOUD_OPENAI },
  [TASKS.ALERT_CORRELATE]:    { primary: CLOUD_OPENAI },
  // Classifier tier is intentionally "groq-or-cheap" today; the platform
  // path uses Groq Llama-8B as Tier 0.
  [TASKS.ALERT_CLASSIFY]:     { primary: CLOUD_GROQ, fallback: CLOUD_OPENAI, fallbackTriggers: ["cloud-error"] },

  // 5.3 notify.* — Phase 3 flips these to user-sidecar. Phase 1 keeps cloud.
  [TASKS.NOTIFY_COMPOSE_EMAIL]:           { primary: CLOUD },
  [TASKS.NOTIFY_COMPOSE_SLACK]:           { primary: CLOUD },
  [TASKS.NOTIFY_COMPOSE_TELEGRAM]:        { primary: CLOUD },
  [TASKS.NOTIFY_COMPOSE_WHATSAPP]:        { primary: CLOUD },
  [TASKS.NOTIFY_COMPOSE_PUSH]:            { primary: CLOUD },
  [TASKS.NOTIFY_COMPOSE_DIGEST]:          { primary: CLOUD },
  [TASKS.NOTIFY_COMPOSE_STATUS_PAGE]:     { primary: CLOUD },
  [TASKS.NOTIFY_COMPOSE_POSTMORTEM_PROSE]: { primary: CLOUD },

  // 5.4 voice.* — local only on desktop. Phase 1 stub.
  [TASKS.VOICE_TTS_ALERT]:  { primary: CLOUD },
  [TASKS.VOICE_TTS_DIGEST]: { primary: CLOUD },

  // 5.5 chat.* — Phase 1 cloud. Conversational moves to local in Phase 3+.
  [TASKS.CHAT_CONVERSATIONAL]:   { primary: CLOUD },
  [TASKS.CHAT_CODE]:             { primary: CLOUD_OPENAI },
  [TASKS.CHAT_INTENT_CLASSIFY]:  { primary: CLOUD_GROQ, fallback: CLOUD_OPENAI, fallbackTriggers: ["cloud-error"] },

  // 5.6 redact.* — Phase 5 enables capture-embedded substrate.
  [TASKS.REDACT_PII_BREADCRUMBS]: { primary: CLOUD },
  [TASKS.REDACT_PII_STACKTRACE]:  { primary: CLOUD },

  // 5.7 gate.* — cloud, always.
  [TASKS.GATE_PREDICTION]:           { primary: CLOUD_OPENAI },
  [TASKS.GATE_SUBSTRATE_REPLAY]:     { primary: CLOUD_OPENAI },
  [TASKS.GATE_COMMUNITY_FIX_MATCH]:  { primary: CLOUD_OPENAI },
};

// ── Workspace overrides ─────────────────────────────────────────────────────

export interface WorkspacePreferences {
  /**
   * Force cloud routing even when local substrate is available (per arch §6.3).
   * Useful for users who don't want local routing even with Inari Live online.
   */
  forceCloudOnly?: boolean;
  /** Per-task substrate override the workspace explicitly set in /settings. */
  taskOverrides?: Partial<Record<TaskName, Target>>;
}

/**
 * Resolve the effective primary target for a task given workspace prefs.
 * In Phase 1 every task already points at cloud, so workspace overrides
 * are wired but inert by default.
 */
export function resolvePrimary(
  task: TaskName,
  prefs?: WorkspacePreferences,
): Target {
  const rule = RULES[task];
  const override = prefs?.taskOverrides?.[task];
  if (override) return override;
  if (prefs?.forceCloudOnly && rule.primary.substrate !== "cloud") {
    // Demote to cloud per workspace flag.
    return { substrate: "cloud" };
  }
  return rule.primary;
}

export function getRule(task: TaskName): Rule {
  return RULES[task];
}
