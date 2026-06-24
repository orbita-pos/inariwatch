/**
 * Intent router — entry point.
 *
 * Two-tier design (2026-05-14 — collapsed from the previous 4-tier stack):
 *
 *   Tier 0 (Layer 0): deterministic kernel, ~0ms, $0, offline.
 *     classifyL0() — pure regex/keyword for shortcut commands like
 *     "alerts", "/status", "uptime", "/project foo". When the regex
 *     matches, resolveIntent calls one cloud IPC and renders the
 *     answer instantly.
 *
 *   Tier 1 (the full LLM): Together-Qwen with the cloud.* tool
 *     catalog. Everything that's NOT a deterministic shortcut goes
 *     straight here. The model decides which tool to call (or
 *     answers conversationally), which is the right abstraction now
 *     that function-calling is robust.
 *
 * Removed (2026-05-14):
 *   - The ONNX/MiniLM semantic classifier was forced to bucket
 *     out-of-domain prompts into one of 11 trained intents — every
 *     SDK question or workspace introspection got silently routed to
 *     `root_cause`. The "raise threshold" lever was a band-aid; the
 *     architectural answer is to let the LLM be the router.
 *   - The Qwen zero-shot oracle was a layer of cost+latency that
 *     duplicated work the Tier 1 LLM already does — when L2 fires it
 *     pays ~$0.000016 + 200-500ms to classify, then resolveIntent
 *     pays another IPC round-trip. The Tier 1 LLM with tool-use
 *     does both jobs in one pass.
 *
 * The Rust IPC handler in `desktop/src-tauri/src/ipc/classify.rs`
 * and the web endpoint `/api/ai/classify` are no longer reachable
 * from this codebase but stay on disk for now; they're flagged for
 * deletion in a follow-up native-side cleanup.
 */

export { classifyL0 } from "./layer0-kernel";
export { resolveIntent } from "./resolvers";
export type { IntentKind, L0Match } from "./types";
