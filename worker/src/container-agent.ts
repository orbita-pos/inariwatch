/**
 * Container agent — runs the AI loop on Hetzner.
 * Same logic as web/lib/ai/container-agent.ts but calls Docker containers
 * on localhost via the Go server (~1ms vs 80-120ms from Vercel).
 *
 * Writes progress to Neon DB for Vercel SSE to poll.
 */

import { callAIWithTools } from "./ai-client.js";
import { db, remediationSessions } from "./db.js";
import { eq } from "drizzle-orm";
import type { AIMessage, AIProvider, ToolDefinition, ToolUseBlock, ToolResultBlock, ContentBlock } from "./ai-client.js";

const MAX_TURNS = 40; // More turns than Vercel (was 15)
const MAX_FILE_SIZE = 15_000;
const MAX_OUTPUT_SIZE = 10_000;
const EXEC_TIMEOUT = 120;
const READ_TIMEOUT = 10;

// ── Blocked files/commands (same as web version) ────────────────────────────

const BLOCKED_FILE_PATTERNS = [
  /^\.env/, /\.env$/, /secrets?\./i, /credentials?\./i, /private[_-]?key/i,
  /\.pem$/, /\.key$/, /\.cert$/, /\.p12$/, /\.pfx$/, /serviceaccount/i, /token\.json$/i,
];

const BLOCKED_WRITE_PATTERNS = [
  ...BLOCKED_FILE_PATTERNS,
  /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/, /bun\.lockb$/,
  /^node_modules\//, /\/node_modules\//,
];

const ALLOWED_COMMANDS = [
  "npm", "npx", "node", "tsc", "git", "cat", "ls", "grep", "find",
  "mkdir", "cp", "head", "tail", "wc", "diff", "echo", "pwd", "which",
  "pnpm", "yarn", "bun",
];

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\//, /\bsudo\b/, /\bchmod\b/, /\bchown\b/, /\bkill\b/, /\bpkill\b/,
  /\bcurl\b/, /\bwget\b/, /\bnc\b/, /\bdd\b/, /\bmkfs\b/, /\bfdisk\b/,
  />\s*\/dev\//, /\|.*\bsh\b/, /\|.*\bbash\b/, /\bsh\s+-c\b/, /\bbash\s+-c\b/, /\bsh\s+[<>|]/,
  /\$\(/, /`[^']*`/, /;\s*\w/,  // subshell $(), backticks, semicolon chaining
];

function isBlockedFile(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  return BLOCKED_FILE_PATTERNS.some((p) => p.test(filename) || p.test(path));
}

function isBlockedWrite(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  return BLOCKED_WRITE_PATTERNS.some((p) => p.test(filename) || p.test(path));
}

function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return { allowed: false, reason: "Command blocked: matches dangerous pattern" };
  }
  const baseCommand = command.trim().split(/\s+/)[0].replace(/^\.\//, "");
  if (!ALLOWED_COMMANDS.includes(baseCommand)) {
    return { allowed: false, reason: `Command "${baseCommand}" is not in the allowed list` };
  }
  return { allowed: true };
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── Tool definitions ────────────────────────────────────────────────────────

const CONTAINER_TOOLS: ToolDefinition[] = [
  { name: "read_file", description: "Read a file from the repository (up to 15K chars).", input_schema: { type: "object", properties: { path: { type: "string", description: "File path relative to repo root" } }, required: ["path"] } },
  { name: "search_code", description: "Search the codebase for patterns using grep.", input_schema: { type: "object", properties: { query: { type: "string", description: "Search string or regex" } }, required: ["query"] } },
  { name: "list_directory", description: "List directory contents. Excludes node_modules and .git.", input_schema: { type: "object", properties: { prefix: { type: "string", description: "Directory path (e.g. 'src/')" } } } },
  { name: "write_file", description: "Write complete file contents. Always provide COMPLETE content.", input_schema: { type: "object", properties: { path: { type: "string", description: "File path" }, content: { type: "string", description: "Complete file content" } }, required: ["path", "content"] } },
  { name: "run_command", description: "Run a shell command for verification: 'npx tsc --noEmit', 'npm run build', 'npm test'.", input_schema: { type: "object", properties: { command: { type: "string", description: "Shell command" } }, required: ["command"] } },
  { name: "submit_fix", description: "Signal fix is complete. ONLY call after tsc and build pass.", input_schema: { type: "object", properties: { explanation: { type: "string" }, files_changed: { type: "array", items: { type: "string" } } }, required: ["explanation", "files_changed"] } },
];

// ── Container API (localhost Go server) ──────────────────────────────────────

const GO_SERVER = process.env.GO_SERVER_URL ?? "http://localhost:9400";
const STAGING_SECRET = process.env.STAGING_API_SECRET ?? "";

async function containerFetch(
  containerId: string, path: string, body: Record<string, unknown>, timeoutMs = 30_000
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GO_SERVER}/container/${containerId}${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STAGING_SECRET}`, "Content-Type": "application/json" },
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
  containerId: string, command: string, timeoutSeconds = EXEC_TIMEOUT
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const data = await containerFetch(containerId, "/exec", {
    command, timeout_seconds: timeoutSeconds, workdir: "/workspace/repo",
  }, (timeoutSeconds + 10) * 1000);
  return {
    exitCode: data.exit_code as number,
    stdout: (data.stdout as string ?? "").slice(0, MAX_OUTPUT_SIZE),
    stderr: (data.stderr as string ?? "").slice(0, MAX_OUTPUT_SIZE),
    durationMs: data.duration_ms as number ?? 0,
  };
}

async function containerWrite(
  containerId: string, filePath: string, content: string
): Promise<void> {
  await containerFetch(containerId, "/write", { path: filePath, content });
}

// ── Tool executor ───────────────────────────────────────────────────────────

async function executeContainerTool(
  tool: ToolUseBlock, containerId: string
): Promise<string> {
  const input = tool.input as Record<string, string>;

  switch (tool.name) {
    case "read_file": {
      if (isBlockedFile(input.path)) return "Error: Access to this file is blocked for security.";
      const result = await containerExec(containerId, `cat ${shellEscape(input.path)}`, READ_TIMEOUT);
      if (result.exitCode !== 0) return `Error: File not found or unreadable.\n${result.stderr}`;
      return result.stdout.slice(0, MAX_FILE_SIZE);
    }
    case "search_code": {
      const result = await containerExec(containerId, `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.json' --include='*.mjs' --include='*.cjs' ${shellEscape(input.query)} . 2>/dev/null | head -50`);
      return result.stdout || "No matches found.";
    }
    case "list_directory": {
      const prefix = input.prefix ?? ".";
      const result = await containerExec(containerId, `find ${shellEscape(prefix)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' 2>/dev/null | head -200`);
      return result.stdout || "Empty directory or not found.";
    }
    case "write_file": {
      if (isBlockedWrite(input.path)) return "Error: Writing to this file is blocked for security.";
      await containerWrite(containerId, input.path, input.content);
      return `Written ${input.content.length} chars to ${input.path}`;
    }
    case "run_command": {
      const check = isCommandAllowed(input.command);
      if (!check.allowed) return `Error: ${check.reason}`;
      const result = await containerExec(containerId, input.command);
      return [
        `Exit code: ${result.exitCode}`,
        result.stdout ? `Stdout:\n${result.stdout}` : null,
        result.stderr ? `Stderr:\n${result.stderr}` : null,
        `Duration: ${result.durationMs}ms`,
      ].filter(Boolean).join("\n");
    }
    case "submit_fix":
      return JSON.stringify({ explanation: input.explanation, files_changed: (tool.input as { files_changed: string[] }).files_changed });
    default:
      return `Unknown tool: ${tool.name}`;
  }
}

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are an expert software engineer fixing a production bug.
You are working inside a container with the repository at /workspace/repo.

You have tools to explore, modify, and VERIFY code:
- read_file: Read files from the repo
- search_code: Search for patterns using grep
- list_directory: List directory contents
- write_file: Write/modify files (apply your fix)
- run_command: Run shell commands (tsc, build, test)
- submit_fix: Signal completion (ONLY after verification)

WORKFLOW:
1. Read the file(s) mentioned in the error/stack trace
2. Check imports to understand what libraries the project uses
3. Read package.json if you need to know the tech stack
4. Apply your fix using write_file with COMPLETE file contents
5. VERIFY: run_command "npx tsc --noEmit" — MUST pass
6. VERIFY: run_command "npm run build" — MUST pass (if applicable)
7. OPTIONAL: run_command "npm test" — non-blocking
8. If tsc or build FAILS, read the error, fix it with write_file, and re-verify
9. When ALL checks pass, call submit_fix with the list of files you changed

CRITICAL RULES:
- NEVER call submit_fix before tsc passes
- Use the same libraries and APIs the project already uses (check imports)
- If the project uses an ORM (Drizzle, Prisma), use its query builder — never raw SQL
- Make MINIMUM changes to fix the bug — do not refactor unrelated code
- Never modify .env files, lock files, migrations, or CI workflows
- If tsc fails, DO NOT give up — read the error message and fix the issue

Respond ONLY with tool calls. Do not output free text.`;
}

// ── Progress tracking ───────────────────────────────────────────────────────

async function updateProgress(
  sessionId: string,
  step: { name: string; status: string; detail?: string }
): Promise<void> {
  try {
    // Read current steps, append new one, write back
    const [session] = await db.select({ steps: remediationSessions.steps })
      .from(remediationSessions).where(eq(remediationSessions.id, sessionId)).limit(1);
    const steps = (session?.steps as { name: string; status: string; detail?: string }[] ?? []);
    steps.push({ ...step, detail: step.detail?.slice(0, 500) });
    await db.update(remediationSessions).set({ steps }).where(eq(remediationSessions.id, sessionId));
  } catch {
    // Non-critical — don't fail the job
  }
}

// ── Container lifecycle ─────────────────────────────────────────────────────

export async function createContainer(
  repoUrl: string, branch: string, githubToken: string, sessionId: string
): Promise<string> {
  const containerId = `agent-${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;
  const res = await fetch(`${GO_SERVER}/container`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STAGING_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: containerId, repo_url: repoUrl, branch, github_token: githubToken, ttl_seconds: 600 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create container (${res.status}): ${text.slice(0, 200)}`);
  }
  return containerId;
}

export async function destroyContainer(containerId: string): Promise<void> {
  try {
    await fetch(`${GO_SERVER}/container/${containerId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${STAGING_SECRET}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* TTL cleanup handles it */ }
}

// ── Main agent loop ─────────────────────────────────────────────────────────

export interface AgentJobParams {
  sessionId: string;
  repoUrl: string;
  branch: string;
  githubToken: string;
  aiKey: string;
  aiProvider: AIProvider;
  exploreModel: string;
  fixModel: string;
  errorContext: string;
  maxTurns?: number;
}

export interface AgentJobResult {
  explanation: string;
  files: { path: string; content: string }[];
  turns: number;
  verified: boolean;
  testsPassed: boolean;
}

export async function runAgentJob(params: AgentJobParams): Promise<AgentJobResult> {
  const {
    sessionId, repoUrl, branch, githubToken,
    aiKey, aiProvider, exploreModel, fixModel, errorContext,
  } = params;
  const maxTurns = params.maxTurns ?? MAX_TURNS;

  // 1. Create container (localhost — fast)
  await updateProgress(sessionId, { name: "container_create", status: "in_progress", detail: "Creating Docker container..." });
  const containerId = await createContainer(repoUrl, branch, githubToken, sessionId);
  await updateProgress(sessionId, { name: "container_create", status: "completed", detail: `Container ${containerId} ready` });

  try {
    // 2. Run AI loop
    const systemPrompt = buildSystemPrompt();
    const messages: AIMessage[] = [{ role: "user", content: errorContext }];
    let tscPassed = false, buildPassed = false, testsPassed = false;

    // Responses API threading for GPT-5.x. Pass-through on other providers.
    let previousResponseId: string | undefined;

    for (let turn = 1; turn <= maxTurns; turn++) {
      await updateProgress(sessionId, {
        name: "container_turn",
        status: "in_progress",
        detail: `Turn ${turn}/${maxTurns}`,
      });

      const isNearEnd = turn > maxTurns - 3;
      const currentModel = isNearEnd ? fixModel : exploreModel;

      // Reasoning effort dial — low during exploration (60% of turns),
      // medium during the fix phase, high in the final 3 turns.
      const frac = turn / maxTurns;
      const reasoningEffort =
        frac <= 0.6 ? "low" : turn <= maxTurns - 3 ? "medium" : "high";

      const response = await callAIWithTools(aiKey, systemPrompt, messages, CONTAINER_TOOLS, {
        maxTokens: 4096,
        model: currentModel,
        timeout: 120_000, // Responses API reasoning can run longer
        provider: aiProvider,
        previousResponseId,
        reasoningEffort,
      });

      // Forward responseId to next turn (GPT-5.x only; no-op elsewhere).
      previousResponseId = response.responseId;

      if (response.stopReason === "end_turn") {
        messages.push({ role: "assistant", content: response.text });
        messages.push({ role: "user", content: "You must use a tool. Write your fix with write_file, verify with run_command, then call submit_fix when tsc and build pass." });
        continue;
      }

      const assistantContent = response.content;
      const toolUses = assistantContent.filter((b): b is ToolUseBlock => b.type === "tool_use");
      messages.push({ role: "assistant", content: assistantContent });

      const toolResults: ToolResultBlock[] = [];

      for (const toolUse of toolUses) {
        try {
          const result = await executeContainerTool(toolUse, containerId);

          // Track verification
          if (toolUse.name === "run_command") {
            const cmd = (toolUse.input as { command: string }).command;
            const exitCode = result.match(/^Exit code: (\d+)/)?.[1];
            if (cmd.includes("tsc") && exitCode === "0") tscPassed = true;
            if (cmd.includes("tsc") && exitCode !== "0") tscPassed = false;
            if (cmd.includes("build") && exitCode === "0") buildPassed = true;
            if (cmd.includes("test") && exitCode === "0") testsPassed = true;

            await updateProgress(sessionId, {
              name: `exec_${cmd.split(/\s+/).slice(0, 2).join("_")}`,
              status: exitCode === "0" ? "completed" : "failed",
              detail: `${cmd} → exit ${exitCode}`,
            });
          }

          // Terminal: submit_fix
          if (toolUse.name === "submit_fix") {
            const submission = JSON.parse(result) as { explanation: string; files_changed: string[] };

            // Read back changed files from container
            const files: { path: string; content: string }[] = [];
            for (const filePath of submission.files_changed) {
              const readResult = await containerExec(containerId, `cat ${shellEscape(filePath)}`, READ_TIMEOUT);
              if (readResult.exitCode === 0 && readResult.stdout) {
                files.push({ path: filePath, content: readResult.stdout });
              }
            }

            await updateProgress(sessionId, {
              name: "container_done",
              status: "completed",
              detail: `Fixed in ${turn} turns. Verified: ${tscPassed && buildPassed}. Tests: ${testsPassed}`,
            });

            return { explanation: submission.explanation, files, turns: turn, verified: tscPassed && buildPassed, testsPassed };
          }

          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Error: ${errMsg}`, is_error: true });
        }
      }

      messages.push({ role: "user", content: toolResults as ContentBlock[] });
    }

    throw new Error(`Agent did not submit fix after ${maxTurns} turns`);
  } finally {
    await destroyContainer(containerId);
  }
}
