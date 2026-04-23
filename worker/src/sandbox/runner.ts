/**
 * Fase 5 — CodeAct sandbox parent runner.
 *
 * Spawns the Deno+Pyodide subprocess, services tool_request RPC calls
 * through the existing validators + container shell, enforces wall-clock
 * + stdout caps, writes one sandbox_audit_log row per invocation.
 *
 * Threat model (from arch doc §Pillar 3, GPT54 §B7):
 *   - Adversary: model emits Python that tries to escape the sandbox.
 *   - Layer 1 (Pyodide): WASM, no os.system / no subprocess / no network.
 *   - Layer 2 (Deno): --allow-none denies file/exec/net to the runner.
 *   - Layer 3 (parent validators): every tool_request goes through
 *     validators.ts before any container action runs.
 *   - Watchdog: kill after 60s wall, 64KB stdout, or 256MB v8 heap.
 *
 * Bug surface to keep small: this file talks to an untrusted process
 * over a text protocol. Every parser path treats malformed input as a
 * fatal error (kill subprocess + return failure), never as something to
 * silently recover from.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sandboxAuditLog, remediationSessions } from "../db.js";
import { executeSandboxTool, type ContainerShell } from "./tool-bindings.js";
import type { SandboxResponse } from "./rpc-protocol.js";

// Watchdog budgets — match GPT54 §B7 Rule 4 + arch doc §Pillar 3.
const WALL_CLOCK_MS = 60_000;
const STDOUT_CAP_BYTES = 64 * 1024;
const V8_HEAP_MB = 256;

// Where the Deno binary + runner script live on the worker host. Operator
// pre-bakes both per worker/src/sandbox/SETUP.md. Default resolves via
// PATH (`deno`) so the CI runners and dev machines that install Deno
// via `setup-deno` / homebrew / scoop work without setting the env var;
// production Hetzner sets SANDBOX_DENO_BINARY=/usr/local/bin/deno in
// /opt/inari-worker/.env to pin the exact binary location.
const DENO_BINARY = process.env.SANDBOX_DENO_BINARY ?? "deno";
const RUNNER_PATH = process.env.SANDBOX_RUNNER_PATH ?? "/opt/sandbox/pyodide-runner.ts";
const SANDBOX_READ_ROOT = process.env.SANDBOX_READ_ROOT ?? "/opt/sandbox";

export type SandboxOutcome =
  | { ok: true; result: unknown; durationMs: number; resultBytes: number }
  | { ok: false; error: string; traceback?: string; durationMs: number; resultBytes: number };

export interface RunSandboxArgs {
  sessionId: string;
  /** Free-form tag stored on sandbox_audit_log.purpose ('hypothesis-H1', 'apply-fix', etc.). */
  purpose: string;
  /** Python source the model emitted. Passed to the runner as-is — never templated. */
  code: string;
  /** Container shell bound to the active gVisor container. */
  shell: ContainerShell;
  /** Optional ai_usage_logs row id linking this invocation to the surrounding turn. */
  aiUsageLogId?: string | null;
}

/**
 * Run one CodeAct sandbox invocation. Returns a structured outcome and
 * persists one row to sandbox_audit_log (fire-and-forget — telemetry
 * failure must never propagate).
 */
export async function runSandbox(args: RunSandboxArgs): Promise<SandboxOutcome> {
  const start = Date.now();
  const codeHash = sha256Hex(args.code);

  let outcome: SandboxOutcome;
  try {
    outcome = await runDenoSubprocess(args);
  } catch (err) {
    outcome = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      resultBytes: 0,
    };
  }

  void writeAudit({
    sessionId: args.sessionId,
    aiUsageLogId: args.aiUsageLogId ?? null,
    codeHash,
    purpose: args.purpose,
    durationMs: outcome.durationMs,
    resultBytes: outcome.resultBytes,
    success: outcome.ok,
    error: outcome.ok ? null : outcome.error,
  });

  return outcome;
}

interface SubprocessHandle {
  child: ChildProcessWithoutNullStreams;
  buffer: { value: string };
  stdoutBytes: { value: number };
}

function spawnDeno(): SubprocessHandle {
  // SANDBOX_DENO_DIR points the Deno subprocess at a pre-populated npm
  // cache (Pyodide 0.28) so it never reaches out to the registry at
  // remediation time. On Hetzner this is /opt/sandbox/.deno-cache per
  // SETUP.md; in CI the workflow sets it to /tmp/sandbox-cache. Deno
  // 2.x treats the repo's package.json as `nodeModules: manual`, which
  // breaks bare `npm:` specifiers — running with a clean DENO_DIR
  // outside the repo bypasses that mode entirely. If the var isn't set
  // (dev box without a pre-bake), the spawn inherits parent env which
  // is almost always what the caller wants for local smoke-testing.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.env.SANDBOX_DENO_DIR) {
    env.DENO_DIR = process.env.SANDBOX_DENO_DIR;
  }

  const child = spawn(
    DENO_BINARY,
    [
      "run",
      "--allow-none",
      `--allow-read=${SANDBOX_READ_ROOT}`,
      "--no-prompt",
      `--v8-flags=--max-old-space-size=${V8_HEAP_MB}`,
      RUNNER_PATH,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env },
  );
  return { child, buffer: { value: "" }, stdoutBytes: { value: 0 } };
}

async function runDenoSubprocess(args: RunSandboxArgs): Promise<SandboxOutcome> {
  const start = Date.now();
  const handle = spawnDeno();
  const { child, buffer, stdoutBytes } = handle;

  let killed: "watchdog" | "stdout-cap" | null = null;

  // Wall-clock watchdog. Fires kill -9 if the subprocess hasn't sent a
  // terminal (`done` or `error`) message within WALL_CLOCK_MS.
  const watchdog = setTimeout(() => {
    if (child.exitCode === null) {
      killed = "watchdog";
      try { child.kill("SIGKILL"); } catch {}
    }
  }, WALL_CLOCK_MS);

  // Stdout cap — protects the parent from a Pyodide-side flood that
  // would otherwise OOM the worker.
  const onStdout = (chunk: Buffer): void => {
    stdoutBytes.value += chunk.length;
    if (stdoutBytes.value > STDOUT_CAP_BYTES && child.exitCode === null) {
      killed = "stdout-cap";
      try { child.kill("SIGKILL"); } catch {}
      return;
    }
    buffer.value += chunk.toString("utf8");
  };
  child.stdout.on("data", onStdout);

  // Capture stderr only for diagnostics on failure; never echo to parent
  // stdout (would corrupt our own output if the worker is being read by
  // anything line-based).
  const stderrBuf: Buffer[] = [];
  child.stderr.on("data", (c: Buffer) => stderrBuf.push(c));

  const send = (msg: unknown): void => {
    if (child.exitCode === null && !child.stdin.destroyed) {
      try { child.stdin.write(JSON.stringify(msg) + "\n"); } catch {}
    }
  };

  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.once("exit", (code) => resolve({ code }));
  });

  try {
    const ready = await readMessage(handle, exited);
    if (!ready || ready.type !== "ready") {
      return finalize({
        ok: false,
        error: ready ? `expected 'ready', got ${ready.type}` : "subprocess exited before ready",
        durationMs: Date.now() - start,
        resultBytes: 0,
      });
    }

    send({ type: "init", session: args.sessionId, code: args.code });

    while (true) {
      const msg = await readMessage(handle, exited);
      if (!msg) {
        return finalize({
          ok: false,
          error: killed === "watchdog"
            ? `sandbox killed after ${WALL_CLOCK_MS}ms wall-clock`
            : killed === "stdout-cap"
              ? `sandbox killed after ${STDOUT_CAP_BYTES} bytes stdout`
              : `subprocess exited (${stderrTail(stderrBuf)})`,
          durationMs: Date.now() - start,
          resultBytes: stdoutBytes.value,
        });
      }
      if (msg.type === "tool_request") {
        const result = await executeSandboxTool(msg.tool, msg.input, args.shell);
        send({
          type: "tool_response",
          id: msg.id,
          result: result.ok ? result.data : { error: result.error },
        });
        continue;
      }
      if (msg.type === "done") {
        const serialized = safeStringify(msg.result);
        return finalize({
          ok: true,
          result: msg.result,
          durationMs: Date.now() - start,
          resultBytes: serialized.length,
        });
      }
      if (msg.type === "error") {
        return finalize({
          ok: false,
          error: msg.message ?? "sandbox error",
          traceback: msg.traceback,
          durationMs: Date.now() - start,
          resultBytes: stdoutBytes.value,
        });
      }
      // Unknown message type — fail closed. The protocol allowlist is
      // small and any unexpected type is either a bug or an escape attempt.
      return finalize({
        ok: false,
        error: `unexpected sandbox message: ${(msg as { type?: string }).type ?? "unknown"}`,
        durationMs: Date.now() - start,
        resultBytes: stdoutBytes.value,
      });
    }
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }

  function finalize(o: SandboxOutcome): SandboxOutcome {
    return o;
  }
}

/**
 * Read one line-delimited JSON message from the subprocess buffer or
 * resolve to null when the subprocess exits before another message arrives.
 */
async function readMessage(
  handle: SubprocessHandle,
  exited: Promise<{ code: number | null }>,
): Promise<SandboxResponse | null> {
  while (true) {
    const newline = handle.buffer.value.indexOf("\n");
    if (newline >= 0) {
      const line = handle.buffer.value.slice(0, newline);
      handle.buffer.value = handle.buffer.value.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        return JSON.parse(line) as SandboxResponse;
      } catch {
        return null; // unparseable line = fail closed
      }
    }
    const winner = await Promise.race([
      new Promise<"data">((resolve) => {
        const onData = () => {
          handle.child.stdout.off("data", onData);
          resolve("data");
        };
        handle.child.stdout.on("data", onData);
      }),
      exited.then(() => "exit" as const),
    ]);
    if (winner === "exit" && handle.buffer.value.indexOf("\n") < 0) {
      return null;
    }
  }
}

function stderrTail(parts: Buffer[]): string {
  return Buffer.concat(parts).toString("utf8").slice(-500);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

interface AuditRow {
  sessionId: string;
  aiUsageLogId: string | null;
  codeHash: string;
  purpose: string;
  durationMs: number;
  resultBytes: number;
  success: boolean;
  error: string | null;
}

async function writeAudit(row: AuditRow): Promise<void> {
  try {
    // Audit row's session_id is nullable in the schema, but we only
    // accept rows tied to a real session — defensive guard against
    // accidentally writing orphaned audit records.
    const exists = await db
      .select({ id: remediationSessions.id })
      .from(remediationSessions)
      .where(eq(remediationSessions.id, row.sessionId))
      .limit(1);
    const sessionId = exists[0]?.id ?? null;

    await db.insert(sandboxAuditLog).values({
      sessionId,
      aiUsageLogId: row.aiUsageLogId,
      codeHash: row.codeHash,
      purpose: row.purpose.slice(0, 200),
      resultSizeBytes: Math.max(0, row.resultBytes | 0),
      durationMs: Math.max(0, row.durationMs | 0),
      success: row.success,
      error: row.error?.slice(0, 1000) ?? null,
    });
  } catch (err) {
    console.warn(
      "[sandbox] audit insert failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
