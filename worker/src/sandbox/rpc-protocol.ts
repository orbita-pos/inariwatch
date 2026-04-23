/**
 * Fase 5 — CodeAct sandbox JSON-RPC protocol (parent ↔ Deno subprocess).
 *
 * Line-delimited JSON over stdin/stdout. The parent (worker process)
 * spawns the Deno subprocess, sends an `init` with the Python code, then
 * services every `tool_request` by validating + executing against the
 * existing tool handlers and returning a `tool_response`.
 *
 * Source of truth: GPT54_AGENT_OPTIMIZATION_PLAN.md §B5. Kept minimal
 * because the contract crosses a process boundary — adding a field here
 * means coordinating two processes' versions.
 */
export type SandboxRequest =
  | { type: "init"; session: string; code: string }
  | { type: "tool_response"; id: string; result: unknown };

export type SandboxResponse =
  | { type: "ready" }
  | { type: "tool_request"; id: string; tool: string; input: unknown }
  | { type: "done"; result: unknown }
  | { type: "error"; message: string; traceback?: string };

/**
 * Names of the six tools the sandbox can request. Anything outside this set
 * is rejected by the parent before any handler is invoked — defense-in-depth
 * against the model emitting Python that calls a tool that wasn't registered
 * (typos, fabricated names, escape attempts).
 */
export const SANDBOX_TOOL_ALLOWLIST = [
  "read_file",
  "write_file",
  "apply_patch",
  "run_command",
  "search_code",
  "list_directory",
] as const;

export type SandboxTool = (typeof SANDBOX_TOOL_ALLOWLIST)[number];

export function isSandboxTool(name: string): name is SandboxTool {
  return (SANDBOX_TOOL_ALLOWLIST as readonly string[]).includes(name);
}
