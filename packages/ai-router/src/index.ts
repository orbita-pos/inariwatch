// Public surface of @inariwatch/ai-router.
//
// Surfaces (web, desktop, CLI, capture, MCP) MUST import from this entry
// point only. They MUST NOT import from `./providers/*` directly — the
// ESLint lockdown rule enforces the boundary in CI.

export {
  dispatch,
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
  DispatchToolUse,
  DispatchVision,
  DispatchEmbed,
  DispatchHints,
  WorkspaceContext,
  CallOpts,
} from "./dispatch";
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
