// Task taxonomy. Per INARI_AI_ARCHITECTURE.md §5 (LOCKED 2026-05-02).
//
// Every AI call in the monorepo tags itself with one of these names. The
// router (rules.ts + dispatch.ts) decides where the call runs based on the
// task. Adding a new AI feature means: 1) add a task here, 2) add a rule.

export const TASKS = {
  // 5.1 code.* — code understanding & modification (CLOUD ONLY, locked)
  CODE_FIX_SINGLE_SHOT: "code.fix.single-shot",
  CODE_FIX_AGENT_LOOP: "code.fix.agent-loop",
  CODE_REVIEW_SELF: "code.review.self",
  CODE_REVIEW_SECURITY: "code.review.security",
  CODE_RISK_ASSESS: "code.risk.assess",
  CODE_FINGERPRINT: "code.fingerprint",
  CODE_FIM_COMPLETION: "code.fim.completion",
  CODE_APPLY_DIFF: "code.apply.diff",
  CODE_EMBED: "code.embed",

  // 5.2 alert.* — alert ingestion & analysis (HYBRID)
  ALERT_AUTO_ANALYZE: "alert.auto-analyze",
  ALERT_CORRELATE: "alert.correlate",
  ALERT_CLASSIFY: "alert.classify",

  // 5.3 notify.* — notification composition (LOCAL when user online, cloud fallback)
  NOTIFY_COMPOSE_EMAIL: "notify.compose.email",
  NOTIFY_COMPOSE_SLACK: "notify.compose.slack",
  NOTIFY_COMPOSE_TELEGRAM: "notify.compose.telegram",
  NOTIFY_COMPOSE_WHATSAPP: "notify.compose.whatsapp",
  NOTIFY_COMPOSE_PUSH: "notify.compose.push",
  NOTIFY_COMPOSE_DIGEST: "notify.compose.digest",
  NOTIFY_COMPOSE_STATUS_PAGE: "notify.compose.status-page",
  NOTIFY_COMPOSE_POSTMORTEM_PROSE: "notify.compose.postmortem-prose",

  // 5.4 voice.* — voice surface (LOCAL only)
  VOICE_TTS_ALERT: "voice.tts.alert",
  VOICE_TTS_DIGEST: "voice.tts.digest",

  // 5.5 chat.* — conversational surfaces (HYBRID with intent routing)
  CHAT_CONVERSATIONAL: "chat.conversational",
  CHAT_CODE: "chat.code",
  CHAT_INTENT_CLASSIFY: "chat.intent-classify",

  // 5.6 redact.* — privacy-sensitive transforms (LOCAL preferred)
  REDACT_PII_BREADCRUMBS: "redact.pii.breadcrumbs",
  REDACT_PII_STACKTRACE: "redact.pii.stacktrace",

  // 5.7 gate.* — auto-merge gate evaluators (CLOUD)
  GATE_PREDICTION: "gate.prediction",
  GATE_SUBSTRATE_REPLAY: "gate.substrate-replay",
  GATE_COMMUNITY_FIX_MATCH: "gate.community-fix-match",
} as const;

export type TaskName = (typeof TASKS)[keyof typeof TASKS];

export type TaskNamespace =
  | "code"
  | "alert"
  | "notify"
  | "voice"
  | "chat"
  | "redact"
  | "gate";

export function namespaceOf(task: TaskName): TaskNamespace {
  return task.split(".")[0] as TaskNamespace;
}

export const ALL_TASKS: readonly TaskName[] = Object.values(TASKS);

// Compile-time exhaustiveness — adding a new task here forces every
// switch over TaskName to be updated.
export function assertExhaustiveTask(task: never): never {
  throw new Error(`Unhandled task: ${String(task)}`);
}
