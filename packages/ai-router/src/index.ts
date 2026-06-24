// Public surface of @inariwatch/ai-router.
//
// Surfaces (web, desktop, CLI, capture, MCP) MUST import from this entry
// point only. They MUST NOT import from `./providers/*` directly — the
// ESLint lockdown rule enforces the boundary in CI.

export {
  dispatch,
  dispatchStream,
  callAI,
  callAIWithUsage,
  callAIWithTools,
  callAIVision,
  callAIEmbed,
  detectProvider,
  buildOpenAIResponsesInput,
  buildToolsWithCache,
  buildMessagesWithCache,
} from "./dispatch";
export type {
  DispatchInput,
  DispatchOutput,
  DispatchMode,
  DispatchComplete,
  DispatchStreamInput,
  DispatchToolUse,
  DispatchVision,
  DispatchEmbed,
  DispatchHints,
  StreamChunk,
  WorkspaceContext,
  CallOpts,
} from "./dispatch";

export { validateProviderKey } from "./providers";
export type { ValidateKeyResult } from "./providers";

export { runGrader } from "./providers";
export type { GraderRunRequest, GraderRunResult } from "./providers/openai";

export { runManagedRemediation } from "./providers/anthropic-managed-agent";
export type {
  ManagedAgentParams,
  ManagedAgentResult,
} from "./providers/anthropic-managed-agent";

// v0.3 S2 relay client — surfaced for non-AI dispatches (Inari Live V1
// Session 3 wires `project.wizard.open` through it). Lockdown rule allows
// these symbols outside providers/ because the relay is task-agnostic
// transport, not a provider SDK.
export {
  RelayError,
  dispatchToRelay,
  readRelayConfigFromEnv,
} from "./providers/relay";
export type {
  RelayClientConfig,
  RelayDispatchRequest,
  RelayDispatchResponse,
  RelayErrorCode,
} from "./providers/relay";
export type {
  AIMessage,
  AIVisionMessage,
  AIResponse,
  AIUsage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  ToolUseResponse,
  CompleteOpts,
  ToolUseOpts,
  VisionOpts,
  StreamToolCallDelta,
} from "./providers/types";

export { TASKS, ALL_TASKS, namespaceOf, assertExhaustiveTask } from "./tasks";
export type { TaskName, TaskNamespace } from "./tasks";

export {
  RULES,
  resolvePrimary,
  getRule,
} from "./rules";
export type {
  AIProvider,
  Rule,
  Substrate,
  Target,
  FallbackTrigger,
  WorkspacePreferences,
} from "./rules";

export {
  emitReceipt,
  registerReceiptSink,
  clearReceiptSinks,
  receiptSinkCount,
} from "./receipts";
export type { RouterReceipt, ReceiptSink } from "./receipts";

// v0.3 S3 — eval harness. Surfaces (web/scripts/run-eval.ts, /admin/ai-eval)
// import these to drive cross-substrate quality measurement.
// v0.3 S4 — extends with slack / telegram / push corpora + judges.
export {
  NOTIFY_COMPOSE_EMAIL_CORPUS,
} from "./eval/corpus";
export type {
  ComposeEmailEvalInput,
  ComposeEmailEvalRubric,
  ComposeEmailEvalItem,
} from "./eval/corpus";
export {
  PROMOTION_THRESHOLD,
  buildJudgePrompt,
  buildReport,
  makeGpt4oMiniJudge,
  scoreItem,
  scoreItemWith,
  scoreRubric,
} from "./eval/judge";
export type {
  ComposeEmailEvalOutput,
  EvalReport,
  ItemScore,
  JudgeFn,
} from "./eval/judge";
export { runEval, SUPPORTED_TASKS } from "./eval/run";

// v0.3 S4 — channel-specific exports for slack/telegram/push.
export { NOTIFY_COMPOSE_SLACK_CORPUS } from "./eval/corpus-slack";
export type {
  ComposeSlackEvalInput,
  ComposeSlackEvalRubric,
  ComposeSlackEvalItem,
} from "./eval/corpus-slack";
export { NOTIFY_COMPOSE_TELEGRAM_CORPUS } from "./eval/corpus-telegram";
export type {
  ComposeTelegramEvalInput,
  ComposeTelegramEvalRubric,
  ComposeTelegramEvalItem,
} from "./eval/corpus-telegram";
export { NOTIFY_COMPOSE_PUSH_CORPUS } from "./eval/corpus-push";
export type {
  ComposePushEvalInput,
  ComposePushEvalRubric,
  ComposePushEvalItem,
} from "./eval/corpus-push";
export {
  buildPushJudgePrompt,
  buildSlackJudgePrompt,
  buildTelegramJudgePrompt,
  countUnescapedReserved,
  extractSlackSectionText,
  findFenceMarkers,
  findHereMention,
  scoreRubricPush,
  scoreRubricSlack,
  scoreRubricTelegram,
  MARKDOWNV2_RESERVED,
} from "./eval/judge-channels";
export type {
  ComposeSlackEvalOutput,
  ComposeTelegramEvalOutput,
  ComposePushEvalOutput,
} from "./eval/judge-channels";

// v0.3 S5 — WhatsApp eval corpus + judge + voice WAV smoke check.
export {
  NOTIFY_COMPOSE_WHATSAPP_CORPUS,
} from "./eval/whatsapp-corpus";
export type {
  ComposeWhatsappEvalInput,
  ComposeWhatsappEvalRubric,
  ComposeWhatsappEvalItem,
} from "./eval/whatsapp-corpus";
export {
  buildWhatsappJudgePrompt,
  makeWhatsappGpt4oMiniJudge,
  scoreWhatsappItem,
  scoreWhatsappRubric,
  checkVoiceWav,
} from "./eval/whatsapp-judge";
export type {
  ComposeWhatsappEvalOutput,
  WhatsappItemScore,
  WhatsappJudgeFn,
  VoiceSmokeResult,
} from "./eval/whatsapp-judge";
