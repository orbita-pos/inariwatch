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
  scoreRubric,
} from "./eval/judge";
export type {
  ComposeEmailEvalOutput,
  EvalReport,
  ItemScore,
  JudgeFn,
} from "./eval/judge";
export { runEval } from "./eval/run";

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
