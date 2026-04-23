/**
 * Fase 5 — parent-side tool router for the CodeAct sandbox.
 *
 * The Pyodide subprocess emits `tool_request` messages over JSON-RPC; the
 * parent looks up the tool name here, validates the input via the same
 * validators the individual tools use (worker/src/sandbox/validators.ts),
 * and dispatches to a handler that talks to the gVisor container exactly
 * the way container-agent.ts does for explicit tool calls.
 *
 * GPT54 §B7 Rule 1 — *all* authorization happens here, never inside the
 * sandbox. A bug in this file is a security bug.
 */

import {
  isBlockedFile,
  isBlockedWrite,
  isCommandAllowed,
  isPathSafe,
} from "./validators.js";
import { isSandboxTool } from "./rpc-protocol.js";

/**
 * Container shell — opaque to this module on purpose. The runner constructs
 * one bound to the active gVisor container and passes it in. We never store
 * a reference: every bind happens fresh per sandbox invocation so a leaked
 * shell can't be reused across sessions.
 */
export interface ContainerShell {
  exec: (
    command: string,
    timeoutSeconds?: number,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  write: (path: string, content: string) => Promise<void>;
  applyPatch: (envelope: string) => Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
}

const READ_TIMEOUT = 10;
const EXEC_TIMEOUT = 240;
const MAX_OUTPUT_BYTES = 10_000;
const MAX_FILE_BYTES = 15_000;

/**
 * Shape returned to the sandbox over RPC. Errors are values (not exceptions
 * thrown over the boundary) so the Python side can branch on them with
 * `if "error" in result:` — matches the worked example in GPT54 §B8.
 */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Dispatch a single RPC tool_request. Returns a ToolResult — never throws
 * across the process boundary; errors come back as `{ ok: false, error }`
 * so the runner can serialize them as `tool_response` payloads cleanly.
 */
export async function executeSandboxTool(
  toolName: string,
  rawInput: unknown,
  shell: ContainerShell,
): Promise<ToolResult> {
  if (!isSandboxTool(toolName)) {
    return { ok: false, error: `unknown tool: ${toolName}` };
  }

  const input = (rawInput ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case "read_file": {
      const path = typeof input.path === "string" ? input.path : "";
      if (!path) return { ok: false, error: "read_file: 'path' is required" };
      const safe = isPathSafe(path);
      if (!safe.safe) return { ok: false, error: `read_file: ${safe.reason}` };
      if (isBlockedFile(path)) return { ok: false, error: "read_file: access blocked for sensitive file" };
      const r = await shell.exec(`cat ${shellEscape(path)}`, READ_TIMEOUT);
      if (r.exitCode !== 0) return { ok: false, error: `read_file: not found or unreadable` };
      return { ok: true, data: r.stdout.slice(0, MAX_FILE_BYTES) };
    }

    case "write_file": {
      const path = typeof input.path === "string" ? input.path : "";
      const content = typeof input.content === "string" ? input.content : "";
      if (!path) return { ok: false, error: "write_file: 'path' is required" };
      if (typeof input.content !== "string") return { ok: false, error: "write_file: 'content' must be a string" };
      const safe = isPathSafe(path);
      if (!safe.safe) return { ok: false, error: `write_file: ${safe.reason}` };
      if (isBlockedWrite(path)) return { ok: false, error: "write_file: writing to this path is blocked" };
      await shell.write(path, content);
      return { ok: true, data: { written: content.length, path } };
    }

    case "apply_patch": {
      const envelope = typeof input.patch === "string" ? input.patch : "";
      if (!envelope) return { ok: false, error: "apply_patch: 'patch' is required" };
      const result = await shell.applyPatch(envelope);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: result.summary };
    }

    case "run_command": {
      const command = typeof input.command === "string" ? input.command : "";
      if (!command) return { ok: false, error: "run_command: 'command' is required" };
      const check = isCommandAllowed(command);
      if (!check.allowed) return { ok: false, error: `run_command: ${check.reason}` };
      const r = await shell.exec(command, EXEC_TIMEOUT);
      return {
        ok: true,
        data: {
          exitCode: r.exitCode,
          stdout: r.stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr: r.stderr.slice(0, MAX_OUTPUT_BYTES),
          durationMs: r.durationMs,
        },
      };
    }

    case "search_code": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      if (!pattern) return { ok: false, error: "search_code: 'pattern' is required" };
      // Same grep shape as the explicit search_code tool — keeps results
      // identical regardless of whether the agent invoked search_code
      // directly or via execute_plan.
      const r = await shell.exec(
        `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.json' --include='*.mjs' --include='*.cjs' ${shellEscape(pattern)} . 2>/dev/null | head -50`,
        15,
      );
      return { ok: true, data: r.stdout || "" };
    }

    case "list_directory": {
      const path = typeof input.path === "string" ? input.path : ".";
      const safe = isPathSafe(path);
      if (!safe.safe) return { ok: false, error: `list_directory: ${safe.reason}` };
      const r = await shell.exec(
        `find ${shellEscape(path)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' 2>/dev/null | head -200`,
        READ_TIMEOUT,
      );
      return { ok: true, data: r.stdout || "" };
    }
  }
}
