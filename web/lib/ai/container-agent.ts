/**
 * Container-based remediation agent — the AI explores and fixes code inside
 * a Docker container on the Hetzner staging server with full shell access.
 *
 * Tools: read_file, search_code, list_directory, write_file, run_command, submit_fix
 *
 * Unlike the agentic loop (which reads via GitHub API and can't verify),
 * this agent can write files, run tsc/build/test, and self-correct inside
 * the container before pushing. Only verified code leaves the container.
 *
 * Falls back to the regular agentic loop if the container is unavailable.
 */

import type { ToolDefinition, AIMessage, ContentBlock, ToolUseBlock, ToolResultBlock, AIProvider } from "./client";
import { callAIWithTools } from "./client";

const MAX_TURNS = 15;
const MAX_FILE_SIZE = 15_000; // chars per file read
const MAX_OUTPUT_SIZE = 10_000; // chars per command output
const EXEC_TIMEOUT = 30; // seconds per command (was 120 — most commands finish in <10s, a hung npm install shouldn't burn 2 min of budget)
const BUILD_TIMEOUT = 60; // seconds for build/test commands (npm run build, cargo build, etc.)
const READ_TIMEOUT = 10;

// ── Blocked Files (shared with agentic-loop.ts) ─────────────────────────────

const BLOCKED_FILE_PATTERNS = [
  /^\.env/,
  /\.env$/,
  /secrets?\./i,
  /credentials?\./i,
  /private[_-]?key/i,
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /\.p12$/,
  /\.pfx$/,
  /serviceaccount/i,
  /token\.json$/i,
];

const BLOCKED_WRITE_PATTERNS = [
  ...BLOCKED_FILE_PATTERNS,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /bun\.lockb$/,
  /^node_modules\//,
  /\/node_modules\//,
];

function isBlockedFile(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  return BLOCKED_FILE_PATTERNS.some((p) => p.test(filename) || p.test(path));
}

function isBlockedWrite(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  return BLOCKED_WRITE_PATTERNS.some((p) => p.test(filename) || p.test(path));
}

// ── Command Safety ──────────────────────────────────────────────────────────

const ALLOWED_COMMANDS = [
  // Unix basics
  "cat", "ls", "grep", "find", "mkdir", "cp", "head", "tail", "wc", "diff",
  "echo", "pwd", "which", "env", "test", "true", "false",
  // Version control
  "git",
  // Node.js ecosystem
  "npm", "npx", "node", "tsc", "pnpm", "yarn", "bun", "deno", "tsx",
  // Python ecosystem
  "python", "python3", "pip", "pip3", "poetry", "uv", "pipenv",
  "pytest", "mypy", "ruff", "black", "flake8",
  // Go ecosystem
  "go", "gofmt", "golangci-lint",
  // Rust ecosystem
  "cargo", "rustc", "rustfmt", "clippy-driver",
  // Java ecosystem
  "java", "javac", "mvn", "gradle", "./gradlew", "./mvnw",
  // Ruby ecosystem
  "ruby", "bundle", "rake", "rspec",
  // Build systems
  "make", "cmake", "ninja",
];

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\//,    // rm -rf /
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bcurl\b/,            // no arbitrary HTTP (npm registry handled by npm)
  /\bwget\b/,
  /\bnc\b/,              // netcat
  /\bdd\b/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  />\s*\/dev\//,         // redirect to devices
  /\|.*\bsh\b/,          // pipe to shell
  /\|.*\bbash\b/,
  /\bsh\s+-c\b/,          // direct sh -c invocation
  /\bbash\s+-c\b/,        // direct bash -c invocation
  /\bsh\s+[<>|]/,         // sh with redirects
  /\$\(/,                 // subshell command substitution
  /`[^']*`/,              // backtick command substitution
  /;\s*\w/,               // semicolon command chaining
];

function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  // Check blocked patterns first
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `Command blocked: matches dangerous pattern` };
    }
  }

  // Extract the base command (first word)
  const baseCommand = command.trim().split(/\s+/)[0].replace(/^\.\//, "");

  if (!ALLOWED_COMMANDS.includes(baseCommand)) {
    return { allowed: false, reason: `Command "${baseCommand}" is not in the allowed list. Allowed: ${ALLOWED_COMMANDS.join(", ")}` };
  }

  return { allowed: true };
}

/** Escape a string for safe use in shell commands. */
function shellEscape(s: string): string {
  // Replace single quotes with escaped version, wrap in single quotes
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── Tool Definitions ────────────────────────────────────────────────────────

const CONTAINER_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file from the repository. Returns the full contents (up to 15K chars). Use to examine code, config, types, schemas.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to repo root (e.g. 'src/index.ts', 'lib/db/schema.ts')" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description: "Search the codebase for patterns using grep. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search string or regex pattern (e.g. 'database query handler', 'ilike', 'captureException')" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_directory",
    description: "List files in the repository, optionally filtered by a directory path. Excludes node_modules and .git.",
    input_schema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Directory path (e.g. 'src/', 'lib/db/'). Omit for full repo listing." },
      },
    },
  },
  {
    name: "apply_patch",
    description: `Apply a patch to one or more files using the envelope format GPT-5.x was trained on. PREFER this over write_file — it is much smaller, faster, and less error-prone for targeted edits.

Envelope format:

*** Begin Patch
*** Update File: path/to/file.ts
@@ optional context (function name, section header) to disambiguate duplicate hunks
 unchanged context line (prefix with SINGLE SPACE)
-line to remove
+line to add
 more context
*** Add File: path/to/new-file.ts
+first line of new file
+second line
*** Delete File: path/to/remove.ts
*** End Patch

Rules:
- Context lines MUST start with a single space. Every context line MUST match the file EXACTLY (whitespace included) except for trailing whitespace on blank lines, which we normalize.
- Include 1-3 context lines above and below each change for unique matching. If the same -/+ block appears multiple times in the file, add text after @@ like "@@ function processOrder" to disambiguate.
- Multiple hunks per file are allowed; separate each with a "@@" header.
- Multiple files per patch are allowed.
- "Add File" is only for NEW files — it errors if the path exists. "Update File" requires the path to exist.

Example (real fix):

*** Begin Patch
*** Update File: app/api/checkout/route.ts
@@ export async function POST
   const { cartItems, shippingAddress } = await req.json()

+  if (!shippingAddress?.city || !shippingAddress?.zip) {
+    return NextResponse.json({ error: "Shipping address required" }, { status: 400 })
+  }
+
   const city = shippingAddress.city.toUpperCase()
*** End Patch`,
    input_schema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Full patch envelope starting with '*** Begin Patch' and ending with '*** End Patch'",
        },
      },
      required: ["patch"],
    },
  },
  {
    name: "write_file",
    description: "Fallback: write COMPLETE file contents. PREFER apply_patch for surgical edits — it is much smaller and less error-prone. Use write_file only when creating a large new file or when apply_patch hunks fail to match repeatedly.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to repo root" },
        content: { type: "string", description: "Complete new file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the repo directory. Use for verification — pick the right tool for the project's language: 'npx tsc --noEmit' and 'npm run build' for TS/JS, 'pytest' or 'python -m mypy' for Python, 'go build ./...' and 'go test ./...' for Go, 'cargo check' and 'cargo test' for Rust, 'mvn verify' or './gradlew build' for Java. ALWAYS verify your fix compiles/passes before calling submit_fix.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run. Examples: 'npx tsc --noEmit', 'pytest tests/', 'go build ./...', 'cargo check', 'mvn verify'" },
      },
      required: ["command"],
    },
  },
  {
    name: "submit_fix",
    description: "Signal that the fix is complete and verified. ONLY call this AFTER the project's compile/build step passed (tsc/build for Node, go build for Go, cargo check for Rust, pytest/mypy for Python, mvn/gradle for Java). List every file you modified.",
    input_schema: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Brief summary of the fix (1-2 sentences for the PR description)" },
        files_changed: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths you modified (e.g. ['src/lib/auth.ts', 'src/utils/validate.ts'])",
        },
      },
      required: ["explanation", "files_changed"],
    },
  },
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContainerAgentParams {
  apiKey: string;
  provider: AIProvider;
  /** Model for exploration (Haiku — cheap). */
  exploreModel: string;
  /** Model for final fix (Sonnet — quality). */
  fixModel: string;
  /** Error context: title, stack trace, severity, additional context. */
  errorContext: string;
  /** Hetzner staging server URL (e.g., https://api.staging.inariwatch.com). */
  containerUrl: string;
  /** Container ID (created by caller). */
  containerId: string;
  /** Staging server bearer token. */
  stagingSecret: string;
  /** Event emitter for streaming status to client. */
  emit: (event: string, data: Record<string, unknown>) => void;
  /**
   * InariLens log context. When provided, each agent turn is recorded
   * individually so a 40-turn container run produces 40 rows, each with
   * per-turn tokens, cost, and the model that handled it.
   */
  log?: {
    userId: string;
    projectId?: string | null;
    alertId?: string | null;
    remediationSessionId?: string | null;
    isPlatformKey?: boolean;
  };
}

export interface ContainerAgentResult {
  /** Brief summary of the fix. */
  explanation: string;
  /** Files modified with their complete content (read back from container). */
  files: { path: string; content: string }[];
  /** Number of turns the agent took. */
  turns: number;
  /** Whether tsc/build passed in the container. */
  verified: boolean;
  /** Whether npm test passed (non-blocking). */
  testsPassed: boolean;
}

// ── Container API Helpers ───────────────────────────────────────────────────

async function containerFetch(
  baseUrl: string,
  containerId: string,
  path: string,
  secret: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/container/${containerId}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Container API error (${res.status}): ${text.slice(0, 200)}`);
  }

  return res.json();
}

async function containerExec(
  baseUrl: string,
  containerId: string,
  command: string,
  secret: string,
  timeoutSeconds = EXEC_TIMEOUT,
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const data = await containerFetch(baseUrl, containerId, "/exec", secret, {
    command,
    timeout_seconds: timeoutSeconds,
    workdir: "/workspace/repo",
  }, (timeoutSeconds + 10) * 1000); // HTTP timeout slightly longer than exec timeout

  return {
    exitCode: data.exit_code as number,
    stdout: (data.stdout as string ?? "").slice(0, MAX_OUTPUT_SIZE),
    stderr: (data.stderr as string ?? "").slice(0, MAX_OUTPUT_SIZE),
    durationMs: data.duration_ms as number ?? 0,
  };
}

async function containerWrite(
  baseUrl: string,
  containerId: string,
  filePath: string,
  content: string,
  secret: string,
): Promise<{ written: boolean; size: number }> {
  const data = await containerFetch(baseUrl, containerId, "/write", secret, {
    path: filePath,
    content,
  });

  return {
    written: data.written as boolean,
    size: data.size as number ?? content.length,
  };
}

// ── Tool Executor ───────────────────────────────────────────────────────────

async function executeContainerTool(
  tool: ToolUseBlock,
  params: ContainerAgentParams,
  filesRead: Map<string, string>,
): Promise<string> {
  const { containerUrl, containerId, stagingSecret } = params;
  const input = tool.input as Record<string, unknown>;

  switch (tool.name) {
    case "read_file": {
      const path = input.path as string;
      if (!path) return "Error: path is required";
      if (isBlockedFile(path)) return `Access denied: ${path} is a sensitive file and cannot be read.`;

      // Context dedup: return cached content if already read this session.
      const cached = filesRead.get(path);
      if (cached) return `(already read — returning cached content)\n${cached}`;

      const result = await containerExec(
        containerUrl, containerId,
        `cat ${shellEscape(path)}`,
        stagingSecret,
        READ_TIMEOUT,
      );

      if (result.exitCode !== 0) return `File not found: ${path}`;
      const truncated = result.stdout.slice(0, MAX_FILE_SIZE);
      filesRead.set(path, truncated);
      return truncated;
    }

    case "search_code": {
      const query = input.query as string;
      if (!query) return "Error: query is required";

      const result = await containerExec(
        containerUrl, containerId,
        `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.json' -l ${shellEscape(query)} . 2>/dev/null | head -20`,
        stagingSecret,
        15,
      );

      if (!result.stdout.trim()) {
        // Try broader search
        const broad = await containerExec(
          containerUrl, containerId,
          `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' ${shellEscape(query)} . 2>/dev/null | head -30`,
          stagingSecret,
          15,
        );
        return broad.stdout || "No results found.";
      }

      // Get context for matching files
      const files = result.stdout.trim().split("\n").slice(0, 5);
      const contextResults: string[] = [];
      for (const file of files) {
        const ctx = await containerExec(
          containerUrl, containerId,
          `grep -n ${shellEscape(query)} ${shellEscape(file)} | head -10`,
          stagingSecret,
          5,
        );
        if (ctx.stdout) contextResults.push(`--- ${file} ---\n${ctx.stdout}`);
      }

      return contextResults.join("\n\n") || "No results found.";
    }

    case "list_directory": {
      const prefix = (input.prefix as string) ?? ".";
      const dir = prefix === "" ? "." : prefix;

      const result = await containerExec(
        containerUrl, containerId,
        `find ${shellEscape(dir)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' | sort | head -100`,
        stagingSecret,
        READ_TIMEOUT,
      );

      if (result.exitCode !== 0) return `Directory not found: ${dir}`;
      return result.stdout || "Empty directory.";
    }

    case "apply_patch": {
      const patchText = input.patch as string;
      if (!patchText) return "Error: patch is required";

      const { parsePatch, applyPatch: runApply, ApplyPatchError } = await import("./apply-patch");
      let parsed;
      try {
        parsed = parsePatch(patchText);
      } catch (e) {
        const msg = e instanceof ApplyPatchError ? e.message : String(e);
        return `Error parsing patch: ${msg}\n\nCheck the envelope format — see the tool description for the exact syntax. Common mistakes: missing space before context lines, no @@ between hunks, missing *** Begin Patch / *** End Patch markers.`;
      }

      // Pre-validate every op against our blocklist BEFORE any writes so a
      // multi-file patch can't half-apply.
      for (const op of parsed.ops) {
        if (op.path.includes("..") || op.path.startsWith("/")) {
          return `Error: path "${op.path}" must be relative to repo root, no '..' or absolute paths.`;
        }
        if (isBlockedWrite(op.path)) {
          return `Error: cannot modify protected file "${op.path}".`;
        }
      }

      // Resolve reads against the container filesystem. We reuse the
      // filesRead cache when possible — the model may patch a file it
      // just read, and we want to avoid a redundant cat.
      const cachedRead = async (path: string): Promise<string | null> => {
        const cached = filesRead.get(path);
        if (cached !== undefined) return cached;
        const result = await containerExec(
          containerUrl, containerId,
          `cat ${shellEscape(path)}`,
          stagingSecret, READ_TIMEOUT,
        );
        if (result.exitCode !== 0) return null;
        const content = result.stdout;
        // Don't cache on the apply path — we're about to invalidate anyway.
        return content;
      };

      let applied;
      try {
        applied = await runApply(parsed, cachedRead);
      } catch (e) {
        const msg = e instanceof ApplyPatchError ? e.message : String(e);
        const ctx = (e as { context?: { path?: string; hunkIndex?: number } }).context;
        const pathHint = ctx?.path ? ` (file: ${ctx.path})` : "";
        return `apply_patch failed${pathHint}:\n${msg}\n\nRe-read the file with read_file, check the exact lines you need to change, and emit a new patch. Context lines must match the file byte-for-byte (trailing whitespace on blank lines is tolerated).`;
      }

      // Write each changed file back to the container and invalidate caches.
      const results: string[] = [];
      for (const c of applied.changed) {
        if (c.op === "delete") {
          const delRes = await containerExec(
            containerUrl, containerId,
            `rm -f ${shellEscape(c.path)}`,
            stagingSecret, READ_TIMEOUT,
          );
          if (delRes.exitCode !== 0) {
            return `Failed to delete ${c.path}: ${delRes.stderr}`;
          }
          filesRead.delete(c.path);
          results.push(`deleted ${c.path}`);
          continue;
        }
        const writeRes = await containerWrite(containerUrl, containerId, c.path, c.content, stagingSecret);
        if (!writeRes.written) {
          return `Failed to write ${c.path}`;
        }
        filesRead.delete(c.path);
        results.push(`${c.op === "add" ? "added" : "updated"} ${c.path} (${writeRes.size} bytes)`);
      }

      return `apply_patch succeeded:\n${results.join("\n")}`;
    }

    case "write_file": {
      const path = input.path as string;
      const content = input.content as string;
      if (!path) return "Error: path is required";
      if (!content) return "Error: content is required";
      if (isBlockedWrite(path)) return `Cannot write to protected file: ${path}`;

      // Path traversal check
      if (path.includes("..") || path.startsWith("/")) {
        return "Error: path must be relative to repo root, no '..' or absolute paths allowed.";
      }

      const result = await containerWrite(containerUrl, containerId, path, content, stagingSecret);
      if (result.written) {
        // Invalidate read cache — file content changed
        filesRead.delete(path);
        return `Written ${result.size} bytes to ${path}`;
      }
      return `Failed to write: ${path}`;
    }

    case "run_command": {
      const command = input.command as string;
      if (!command) return "Error: command is required";

      const check = isCommandAllowed(command);
      if (!check.allowed) return `Error: ${check.reason}`;

      // Build/test commands get a longer timeout than general commands
      const isBuildCmd = /\b(build|test|check|compile|verify|tsc|mypy|pytest|cargo\s+build|go\s+build|mvn|gradle)\b/.test(command);
      const timeout = isBuildCmd ? BUILD_TIMEOUT : EXEC_TIMEOUT;
      const result = await containerExec(containerUrl, containerId, command, stagingSecret, timeout);

      const output = [
        `Exit code: ${result.exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
        `Duration: ${result.durationMs}ms`,
      ].filter(Boolean).join("\n");

      return output;
    }

    case "submit_fix": {
      // Terminal — return the submission payload
      return JSON.stringify({
        explanation: input.explanation,
        files_changed: input.files_changed,
      });
    }

    default:
      return `Unknown tool: ${tool.name}`;
  }
}

// ── System Prompt ───────────────────────────────────────────────────────────

function buildContainerBasePrompt(): string {
  return `You are an expert software engineer fixing a production bug.
You are working inside a container with the repository at /workspace/repo.

You have tools to explore, modify, and VERIFY code:
- read_file: Read files from the repo
- search_code: Search for patterns using grep
- list_directory: List directory contents
- apply_patch: Apply targeted edits via envelope format (PREFERRED for fixes)
- write_file: Fallback — rewrite entire file (use only when apply_patch doesn't fit)
- run_command: Run shell commands (compile, build, test)
- submit_fix: Signal completion (ONLY after verification)

WORKFLOW:
1. Identify the project's language/stack — check for package.json (Node), requirements.txt/pyproject.toml (Python), go.mod (Go), Cargo.toml (Rust), pom.xml/build.gradle (Java). Use list_directory or read_file at the repo root.
2. Read the file(s) mentioned in the error/stack trace.
3. Check imports to understand what libraries the project uses.
4. Apply your fix. PREFER apply_patch with 1-3 lines of context — it is much smaller, more accurate, and is the exact format GPT-5.x was trained on. Fall back to write_file only when replacing an entire file makes sense (new file from scratch, or a complete rewrite).
5. VERIFY with the right command for the project's language:
   - TypeScript: "npx tsc --noEmit" MUST pass
   - JavaScript: "npm run build --if-present"
   - Python: "python -m mypy ." (if configured) or "python -m compileall ."
   - Go: "go build ./..." MUST succeed
   - Rust: "cargo check" MUST succeed
   - Java: "mvn compile" or "./gradlew build"
6. VERIFY build (if the project has a build step): "npm run build", "go build", "cargo build", "mvn package", "./gradlew build".
7. OPTIONAL tests (non-blocking): "npm test", "pytest", "go test ./...", "cargo test", "mvn test".
8. If verification FAILS, read the error, fix it with write_file, and re-verify.
9. When verification passes, call submit_fix with the list of files you changed.

EFFICIENCY RULES:
- NEVER re-read a file you already read in this session. You have the content from your previous read_file call — refer to it directly. Re-reading wastes turns and budget.
- NEVER read files just to "double-check" or "verify" — only read files you haven't seen yet.
- NEVER run the same command twice if it already passed. Once tsc passes, move on.
- For common patterns (null reference, missing import, type mismatch, off-by-one), fix immediately after reading the relevant file — do not explore further.

CRITICAL RULES:
- NEVER call submit_fix before the language-appropriate compile/type-check step passes.
- Use the same libraries and APIs the project already uses (check imports).
- If the project uses an ORM, use its query builder — never raw SQL with user input.
- Make MINIMUM changes to fix the bug — do not refactor unrelated code.
- Never modify .env files, lock files, migrations, or CI workflows.
- If verification fails, DO NOT give up — read the error message and fix the issue.
- Do NOT add comments to your code changes. No "// fixed", "// added null check", or documentation. The explanation in submit_fix describes the change.

Respond ONLY with tool calls. Do not output free text.`;
}

// ── Main Loop ───────────────────────────────────────────────────────────────

export async function runContainerAgent(params: ContainerAgentParams): Promise<ContainerAgentResult> {
  const { apiKey, provider, exploreModel, fixModel, errorContext, containerUrl, containerId, stagingSecret, emit } = params;

  // System prompt depends on the ACTIVE model per turn (mini for exploration
  // turns vs full for the fix turns). We compose per-call below inside the
  // loop. Base prompt carries the workflow + tools; buildGPTRemediationSystemPrompt
  // wraps it with IMMUTABLE_RULES at start + end and applies GPT_OVERLAY /
  // GPT_5_4_OVERLAY when the current model is GPT-like.
  const { buildGPTRemediationSystemPrompt } = await import("./prompts");
  const basePrompt = buildContainerBasePrompt();

  // Track files read across turns — serves cached content on re-reads.
  const filesRead = new Map<string, string>();

  const messages: AIMessage[] = [
    { role: "user", content: errorContext },
  ];

  // Responses API threading (GPT-5.x, store:false). Forward the previous
  // turn's raw output items so reasoning.encrypted_content + function_call
  // pairings carry forward. Without this, reasoning context is lost
  // between tool calls.
  let priorOutput: Array<Record<string, unknown>> | undefined;
  const { effortForTurn } = await import("./openai-config");

  // Verification flags — compile-check, build, and tests. Each is set when a
  // run_command matching the respective pattern succeeds (exit code 0).
  // Patterns cover TypeScript/JavaScript, Python, Go, Rust, Java.
  let compilePassed = false;
  let buildPassed = false;
  let testsPassed = false;

  const COMPILE_CHECK_RE = /\btsc\b|\bmypy\b|\bpython\s+-m\s+compileall\b|\bgo\s+build\b|\bcargo\s+check\b|\bmvn\s+compile\b|\bgradlew\s+(build|compile)/;
  const BUILD_RE = /\bnpm\s+run\s+build\b|\bpnpm\s+build\b|\byarn\s+build\b|\bbun\s+run\s+build\b|\bnext\s+build\b|\bvite\s+build\b|\bcargo\s+build\b|\bgo\s+build\b|\bmvn\s+(package|install)\b|\bgradlew\s+assemble\b/;
  const TEST_RE = /\bnpm\s+test\b|\bpnpm\s+test\b|\byarn\s+test\b|\bpytest\b|\bmvn\s+test\b|\bgradlew\s+test\b|\bgo\s+test\b|\bcargo\s+test\b|\brspec\b|\bvitest\b|\bjest\b/;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    emit("container_turn", { turn, maxTurns: MAX_TURNS });

    // Haiku for exploration (cheap), Sonnet for final fix (quality)
    const isNearEnd = turn > MAX_TURNS - 3;
    const currentModel = isNearEnd ? fixModel : exploreModel;

    // Model-aware system prompt — GPT gets the narration/stop-early overlay,
    // gpt-5.4 also gets the verbosity clamp, every model gets IMMUTABLE_RULES
    // top + bottom.
    const systemPrompt = buildGPTRemediationSystemPrompt(basePrompt, currentModel);

    const response = await callAIWithTools(apiKey, systemPrompt, messages, CONTAINER_TOOLS, {
      maxTokens: 4096,
      model: currentModel,
      timeout: 90_000, // Longer timeout — container commands can take time
      provider,
      priorOutput,
      reasoningEffort: effortForTurn(turn, MAX_TURNS),
      log: params.log
        ? {
            userId: params.log.userId,
            projectId: params.log.projectId,
            alertId: params.log.alertId,
            remediationSessionId: params.log.remediationSessionId,
            feature: "remediation",
            isPlatformKey: params.log.isPlatformKey ?? false,
          }
        : undefined,
    });

    // Forward prior turn's output items (reasoning + function_call pairs)
    // to next turn. GPT-5.x only; no-op on other providers.
    priorOutput = response.priorOutput;

    if (response.stopReason === "end_turn") {
      emit("container_text", { turn, text: response.text.slice(0, 200) });
      messages.push({ role: "assistant", content: response.text });
      messages.push({ role: "user", content: "You must use a tool. Write your fix with write_file, verify with run_command, then call submit_fix when tsc and build pass." });
      continue;
    }

    // Process tool use blocks
    const assistantContent = response.content;
    const toolUses = assistantContent.filter((b): b is ToolUseBlock => b.type === "tool_use");

    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: ToolResultBlock[] = [];

    for (const toolUse of toolUses) {
      // Emit tool invocation (mask file content for write_file)
      const emitInput = toolUse.name === "write_file"
        ? { path: (toolUse.input as { path: string }).path, size: ((toolUse.input as { content: string }).content ?? "").length }
        : toolUse.name === "submit_fix"
          ? toolUse.input
          : toolUse.input;
      emit("container_tool", { turn, tool: toolUse.name, input: emitInput });

      try {
        const result = await executeContainerTool(toolUse, params, filesRead);

        // Track verification status from run_command results
        if (toolUse.name === "run_command") {
          const cmd = (toolUse.input as { command: string }).command;
          const exitCode = result.match(/^Exit code: (\d+)/)?.[1];
          const passed = exitCode === "0";
          if (COMPILE_CHECK_RE.test(cmd)) compilePassed = passed;
          if (BUILD_RE.test(cmd) && passed) buildPassed = true;
          if (TEST_RE.test(cmd) && passed) testsPassed = true;

          emit("container_exec", {
            turn, command: cmd, exitCode: parseInt(exitCode ?? "-1"),
            passed: exitCode === "0",
          });
        }

        // Check if this is the terminal submit_fix
        if (toolUse.name === "submit_fix") {
          const submission = JSON.parse(result) as { explanation: string; files_changed: string[] };

          // Read back changed files from container to get actual content
          const files: { path: string; content: string }[] = [];
          for (const filePath of submission.files_changed) {
            const readResult = await containerExec(
              containerUrl, containerId,
              `cat ${shellEscape(filePath)}`,
              stagingSecret,
              READ_TIMEOUT,
            );
            if (readResult.exitCode === 0 && readResult.stdout) {
              files.push({ path: filePath, content: readResult.stdout });
            }
          }

          emit("container_done", {
            turns: turn,
            files: files.map((f) => f.path),
            verified: compilePassed,
            testsPassed,
          });

          return {
            explanation: submission.explanation,
            files,
            turns: turn,
            verified: compilePassed && buildPassed,
            testsPassed,
          };
        }

        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
        emit("container_result", { turn, tool: toolUse.name, size: result.length });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Error: ${errMsg}`, is_error: true });
        emit("container_error", { turn, tool: toolUse.name, error: errMsg });
      }
    }

    // Add tool results as user message
    messages.push({ role: "user", content: toolResults as ContentBlock[] });
  }

  throw new Error(`Container agent did not submit fix after ${MAX_TURNS} turns`);
}

// ── Container Lifecycle Helpers (for remediate.ts) ──────────────────────────

export async function createContainer(
  stagingUrl: string,
  stagingSecret: string,
  repoUrl: string,
  branch: string,
  githubToken: string,
  sessionId: string,
): Promise<string> {
  const containerId = `agent-${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;

  const res = await fetch(`${stagingUrl}/container`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stagingSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: containerId,
      repo_url: repoUrl,
      branch,
      github_token: githubToken,
      ttl_seconds: 300,
    }),
    signal: AbortSignal.timeout(120_000), // npm install can be slow
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create container (${res.status}): ${text.slice(0, 200)}`);
  }

  return containerId;
}

export async function destroyContainer(
  stagingUrl: string,
  stagingSecret: string,
  containerId: string,
): Promise<void> {
  try {
    await fetch(`${stagingUrl}/container/${containerId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${stagingSecret}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Non-critical — TTL cleanup will handle it
  }
}
