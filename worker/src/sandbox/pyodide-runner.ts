// @ts-nocheck
/**
 * Fase 5 — CodeAct sandbox Deno runner.
 *
 * Spawned by the worker's runner.ts as a subprocess with:
 *   deno run --allow-read=/opt/sandbox \
 *            --no-prompt --node-modules-dir=auto \
 *            --v8-flags=--max-old-space-size=256 \
 *            /opt/sandbox/pyodide-runner.ts
 *
 * Deno's default is deny-everything — omitting --allow-write, --allow-net,
 * --allow-env, --allow-run etc. is what makes this airtight. There is no
 * `--allow-none` flag (despite what some spec drafts suggested); default-
 * deny is achieved by adding only the narrow reads you need.
 *
 * Loads Pyodide from the pre-cached vendor directory (no runtime npm
 * install — the cache lives at /opt/sandbox/.deno-cache per SETUP.md).
 * Reads JSON-RPC from stdin, writes to stdout. Every tool call from the
 * Python code crosses back over RPC to the parent worker, which is the
 * sole authority for what's allowed.
 *
 * @ts-nocheck because this file targets the Deno runtime, not Node — its
 * imports (npm:pyodide@0.28, Deno globals) are unresolvable under the
 * worker's Node tsconfig and shouldn't be type-checked here. CI runs the
 * Deno checker separately via `deno check pyodide-runner.ts`.
 *
 * Source of truth: GPT54_AGENT_OPTIMIZATION_PLAN.md §B6.
 */

import { loadPyodide } from "npm:pyodide@0.28";

const reader = Deno.stdin.readable.getReader();
let buffer = "";

async function readLine(): Promise<string> {
  while (true) {
    const newlineIdx = buffer.indexOf("\n");
    if (newlineIdx >= 0) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      return line;
    }
    const { value, done } = await reader.read();
    if (done) {
      const tail = buffer;
      buffer = "";
      return tail;
    }
    buffer += new TextDecoder().decode(value);
  }
}

function write(msg: unknown): void {
  Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(msg) + "\n"));
}

async function rpcCall(tool: string, input: unknown): Promise<unknown> {
  const id = crypto.randomUUID();
  write({ type: "tool_request", id, tool, input });
  while (true) {
    const line = await readLine();
    if (!line) continue;
    let msg: { type?: string; id?: string; result?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "tool_response" && msg.id === id) return msg.result;
  }
}

write({ type: "ready" });
const initLine = await readLine();
const init = JSON.parse(initLine);
const { code } = init as { code: string };

const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });

// Pyodide exposes JS host globals to Python via `from js import <name>`.
// The right hook is the JS `globalThis` (this realm), NOT a `py.globalThis`
// — older spec drafts mis-described the API. Each function below becomes a
// PyProxy on the Python side that the user code can `await` on.
(globalThis as Record<string, unknown>).read_file      = (p: string) => rpcCall("read_file", { path: p });
(globalThis as Record<string, unknown>).write_file     = (p: string, c: string) => rpcCall("write_file", { path: p, content: c });
(globalThis as Record<string, unknown>).apply_patch    = (env: string) => rpcCall("apply_patch", { patch: env });
(globalThis as Record<string, unknown>).run_command    = (c: string) => rpcCall("run_command", { command: c });
(globalThis as Record<string, unknown>).search_code    = (pat: string, glob = "**/*") => rpcCall("search_code", { pattern: pat, glob });
(globalThis as Record<string, unknown>).list_directory = (p: string) => rpcCall("list_directory", { path: p });

try {
  await py.runPythonAsync(`
from js import read_file, write_file, apply_patch, run_command, search_code, list_directory
import asyncio
result = None

${code}
`);
  const result = py.globals.get("result")?.toJs?.({ dict_converter: Object.fromEntries }) ?? null;
  write({ type: "done", result });
} catch (err) {
  write({ type: "error", message: (err as Error).message, traceback: (err as Error).stack });
} finally {
  py.destroy?.();
  Deno.exit(0);
}
