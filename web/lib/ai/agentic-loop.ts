/**
 * Agentic remediation loop — the AI explores the repo with tools,
 * then submits a fix. Replaces the single-shot "diagnose + fix" pipeline
 * with an iterative tool-use loop that reads files on demand.
 *
 * Tools: read_file, search_code, list_directory, read_package_json,
 *        get_file_structure, submit_fix (terminal)
 *
 * The loop runs max MAX_TURNS iterations. On each turn the LLM either
 * calls a tool (read more code) or calls submit_fix (ends the loop).
 *
 * Falls back to single-shot if the provider doesn't support tool use
 * or if the loop fails.
 */

import type { ToolDefinition, AIMessage, ContentBlock, ToolUseBlock, TextBlock, ToolResultBlock, AIProvider } from "./client";
import { callAIWithTools } from "./client";
import { expandFixFiles } from "./expand-lazy-writes";
import * as gh from "@/lib/services/github-api";

const MAX_TURNS = 15;
const MAX_FILE_SIZE = 15_000; // chars per file read

/** Files the agentic loop must NEVER read — secrets, credentials, env files. */
const BLOCKED_FILE_PATTERNS = [
  /^\.env/,           // .env, .env.local, .env.production
  /\.env$/,           // any file ending in .env
  /secrets?\./i,      // secrets.json, secret.yaml
  /credentials?\./i,  // credentials.json
  /private[_-]?key/i, // private_key.pem
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /\.p12$/,
  /\.pfx$/,
  /serviceaccount/i,  // service-account.json
  /token\.json$/i,
];

function isBlockedFile(path: string): boolean {
  const filename = path.split("/").pop() ?? path;
  return BLOCKED_FILE_PATTERNS.some((p) => p.test(filename) || p.test(path));
}

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
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
    description: "Search the codebase for functions, patterns, or symbols. Returns matching code chunks with file paths and line numbers. Use to find where something is defined or used.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g. 'database query handler', 'ilike', 'captureException')" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_directory",
    description: "List files in the repository, optionally filtered by a directory prefix. Returns file paths sorted alphabetically.",
    input_schema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Directory prefix to filter (e.g. 'src/', 'lib/db/'). Omit for full repo." },
      },
    },
  },
  {
    name: "submit_fix",
    description: "Submit the final fix. This ENDS the loop. For each changed file, use '// ... keep existing code ...' markers for any unchanged block of 4+ lines — only output the lines you changed plus 1-2 lines of surrounding context. The system will expand markers against the original file.",
    input_schema: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Brief summary of the fix (1-2 sentences for the PR description)" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to repo root" },
              content: { type: "string", description: "File content with '// ... keep existing code ...' markers for unchanged sections" },
            },
            required: ["path", "content"],
          },
          description: "Array of files to modify. Use markers for unchanged sections to reduce output size.",
        },
      },
      required: ["explanation", "files"],
    },
  },
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgenticLoopParams {
  apiKey: string;
  provider: AIProvider;
  /** Model for exploration (reading files, searching). Use Haiku for cost. */
  exploreModel: string;
  /** Model for final fix generation (submit_fix). Use Sonnet for quality. */
  fixModel: string;
  systemPrompt: string;
  errorContext: string;
  token: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  projectId: string;
  repoFiles: string[];
  emit: (event: string, data: Record<string, unknown>) => void;
  /**
   * InariLens log context. When provided, each agentic turn is recorded
   * individually so a 15-turn remediation produces 15 rows, each with
   * per-turn tokens, cost, and the model that handled it.
   */
  log?: {
    userId: string;
    alertId?: string | null;
    remediationSessionId?: string | null;
    isPlatformKey?: boolean;
  };
}

export interface AgenticLoopResult {
  explanation: string;
  files: { path: string; content: string }[];
  turns: number;
}

// ── Tool Executors ──────────────────────────────────────────────────────────

async function executeTool(
  tool: ToolUseBlock,
  params: AgenticLoopParams,
  filesRead: Map<string, string>,
): Promise<string> {
  const { token, owner, repo, defaultBranch, projectId, repoFiles } = params;
  const input = tool.input as Record<string, string>;

  switch (tool.name) {
    case "read_file": {
      const path = input.path;
      if (!path) return "Error: path is required";
      if (isBlockedFile(path)) return `Access denied: ${path} is a sensitive file and cannot be read for security reasons.`;

      // Context dedup: return cached content if already read this session.
      // Saves a GitHub API call (~200ms) and prevents the model from wasting turns.
      const cached = filesRead.get(path);
      if (cached) return `(already read — returning cached content)\n${cached}`;

      const content = await gh.getFileContent(token, owner, repo, path, defaultBranch);
      if (content === null) return `File not found: ${path}`;
      const truncated = content.slice(0, MAX_FILE_SIZE);
      filesRead.set(path, truncated);
      return truncated;
    }

    case "search_code": {
      const query = input.query;
      if (!query) return "Error: query is required";
      try {
        const { searchCode } = await import("@/lib/services/code-intelligence.service");
        const results = await searchCode({
          query,
          projectId,
          limit: 5,
          includeGraph: true,
        });
        if (results.length === 0) return "No results found.";
        return results.map((r) =>
          `${r.filePath}:${r.startLine}-${r.endLine} (${r.chunkType} ${r.name})\n${r.code?.slice(0, 1000) ?? ""}`
        ).join("\n\n---\n\n");
      } catch {
        // Code intelligence not indexed — fall back to file listing with grep-like search
        const matches = repoFiles.filter((f) => f.toLowerCase().includes(query.toLowerCase()));
        return matches.length > 0
          ? `Files matching "${query}":\n${matches.slice(0, 20).join("\n")}`
          : `No files matching "${query}". Try a different query.`;
      }
    }

    case "list_directory": {
      const prefix = input.prefix ?? "";
      const filtered = prefix
        ? repoFiles.filter((f) => f.startsWith(prefix))
        : repoFiles;
      return filtered.slice(0, 100).join("\n") + (filtered.length > 100 ? `\n... and ${filtered.length - 100} more` : "");
    }

    case "submit_fix": {
      // Terminal — return the fix payload as-is for the caller to process
      return JSON.stringify({ explanation: input.explanation, files: (tool.input as { files: unknown[] }).files });
    }

    default:
      return `Unknown tool: ${tool.name}`;
  }
}

// ── Build System Prompt ─────────────────────────────────────────────────────

function buildAgenticSystemPrompt(): string {
  return `You are an expert software engineer fixing a production bug.

You have tools to explore the repository: read files, search code, list directories.
When you understand the bug and know how to fix it, call submit_fix.

STRATEGY:
1. Read the file(s) mentioned in the error stack trace
2. Check imports to understand what libraries the project uses
3. Read package.json if you need to know the tech stack
4. Look for existing correct patterns in the same file or nearby files
5. If a correct version of the same logic exists (e.g., in another branch of an if/else), copy that pattern
6. When confident, call submit_fix with changed files using "// ... keep existing code ..." markers for unchanged sections

RULES:
- NEVER re-read a file you already read in this session. Refer to the content from your previous read_file call. Re-reading wastes time and budget.
- NEVER read files just to "verify" — you already have the content. Only re-read if you need a file you haven't seen yet.
- Use the same libraries and APIs the project already uses (check imports)
- If the project uses an ORM (Drizzle, Prisma, etc.), use its query builder — never raw SQL
- Make the MINIMUM change necessary to fix the bug
- In submit_fix, use "// ... keep existing code ..." markers for any unchanged block of 4+ lines. Only output the lines you changed plus 1-2 surrounding lines as anchors. The system expands markers automatically.
- Ensure the code compiles — check types and imports
- Never modify .env files, lock files, migrations, or CI workflows
- Do NOT add comments to your code changes. No "// fixed", "// added null check", or documentation that wasn't already present.

FAST-PATH: For common patterns (null reference, missing import, type mismatch, off-by-one), fix immediately after reading the relevant file — do not explore further.

Respond ONLY with tool calls. Do not output free text.`;
}

// ── Main Loop ───────────────────────────────────────────────────────────────

export async function runAgenticLoop(params: AgenticLoopParams): Promise<AgenticLoopResult> {
  const { apiKey, provider, exploreModel, fixModel, errorContext, emit } = params;

  const systemPrompt = buildAgenticSystemPrompt();

  // Track files read across turns — serves cached content on re-reads,
  // saving GitHub API calls and preventing wasted turns.
  const filesRead = new Map<string, string>();

  // Stall detection — if the agent re-reads the same files or makes no
  // progress for 3 consecutive turns, abort early to save budget.
  const MAX_STALL_TURNS = 3;
  let stallCount = 0;
  let lastToolSignature = "";

  // Start with the error context as the first message
  const messages: AIMessage[] = [
    { role: "user", content: errorContext },
  ];

  // Responses API threading (GPT-5.x, store:false mode). Each turn returns
  // the raw `output` items — we forward them in the next turn's input so
  // reasoning.encrypted_content stays paired with its function_call items.
  // Without this the model loses reasoning context between tool calls
  // (Cursor measured ~30% regression when dropped).
  let priorOutput: Array<Record<string, unknown>> | undefined;
  const { effortForTurn } = await import("./openai-config");

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    emit("agentic_turn", { turn, maxTurns: MAX_TURNS });

    // Context compaction: after turn 8, tool_result contents from early turns
    // are no longer useful (the model has already processed them). Replace
    // large tool results with summaries to keep the context window lean.
    // This prevents the last 3 turns (Sonnet, expensive) from paying for
    // context tokens accumulated during cheap Haiku exploration.
    if (turn === 9 && messages.length > 6) {
      compactMessages(messages);
      emit("agentic_compacted", { turn, messageCount: messages.length });
    }

    // Use explore model (Haiku — cheap) for exploration, fix model (Sonnet — quality) for the last 3 turns
    // This allows the AI to explore cheaply and generate quality fixes
    const isNearEnd = turn > MAX_TURNS - 3;
    const currentModel = isNearEnd ? fixModel : exploreModel;

    const response = await callAIWithTools(apiKey, systemPrompt, messages, TOOLS, {
      maxTokens: 4096,
      model: currentModel,
      timeout: 60000,
      provider,
      priorOutput,
      reasoningEffort: effortForTurn(turn, MAX_TURNS),
      log: params.log
        ? {
            userId: params.log.userId,
            projectId: params.projectId,
            alertId: params.log.alertId,
            remediationSessionId: params.log.remediationSessionId,
            feature: "remediation",
            isPlatformKey: params.log.isPlatformKey ?? false,
          }
        : undefined,
    });

    // Forward the prior turn's raw output items so reasoning+function_call
    // pairing survives. GPT-5.x populates this; other providers leave it
    // undefined (no-op).
    priorOutput = response.priorOutput;

    if (response.stopReason === "end_turn") {
      // LLM stopped without calling a tool — shouldn't happen, nudge it
      emit("agentic_text", { turn, text: response.text.slice(0, 200) });
      messages.push({ role: "assistant", content: response.text });
      messages.push({ role: "user", content: "You must use a tool. Either read more files to understand the codebase, or call submit_fix if you have enough context to generate the fix." });
      continue;
    }

    // Process tool use blocks
    const assistantContent = response.content;
    const toolUses = assistantContent.filter((b): b is ToolUseBlock => b.type === "tool_use");

    // Add assistant message with tool_use blocks
    messages.push({ role: "assistant", content: assistantContent });

    // Check for terminal submit_fix first (before parallel execution)
    const submitFix = toolUses.find((t) => t.name === "submit_fix");
    if (submitFix) {
      emit("agentic_tool", { turn, tool: "submit_fix", input: { files: ((submitFix.input as { files?: { path: string }[] }).files ?? []).map((f) => f.path) } });
      const result = await executeTool(submitFix, params, filesRead);
      const fix = JSON.parse(result) as { explanation: string; files: { path: string; content: string }[] };
      const expandedFiles = expandFixFiles(fix.files, filesRead);
      emit("agentic_done", { turns: turn, files: expandedFiles.map((f) => f.path) });
      return { explanation: fix.explanation, files: expandedFiles, turns: turn };
    }

    // Execute non-terminal tools in parallel (read_file, search_code, list_directory)
    const toolResults: ToolResultBlock[] = [];
    for (const toolUse of toolUses) {
      emit("agentic_tool", { turn, tool: toolUse.name, input: toolUse.input });
    }
    const results = await Promise.allSettled(
      toolUses.map((toolUse) => executeTool(toolUse, params, filesRead)),
    );
    for (let j = 0; j < toolUses.length; j++) {
      const toolUse = toolUses[j];
      const settled = results[j];
      if (settled.status === "fulfilled") {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: settled.value });
        emit("agentic_result", { turn, tool: toolUse.name, size: settled.value.length });
      } else {
        const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Error: ${errMsg}`, is_error: true });
        emit("agentic_error", { turn, tool: toolUse.name, error: errMsg });
      }
    }

    // Stall detection: if the agent calls the same tools with the same inputs
    // for multiple turns in a row, it's stuck in a loop.
    const turnSignature = toolUses.map((t) => `${t.name}:${JSON.stringify(t.input)}`).join("|");
    if (turnSignature === lastToolSignature) {
      stallCount++;
      if (stallCount >= MAX_STALL_TURNS) {
        emit("agentic_stall", { turn, stallCount, signature: turnSignature.slice(0, 200) });
        throw new Error(`Agentic loop stalled — same tool calls for ${stallCount} consecutive turns`);
      }
    } else {
      stallCount = 0;
    }
    lastToolSignature = turnSignature;

    // Add tool results as user message
    messages.push({ role: "user", content: toolResults as ContentBlock[] });
  }

  throw new Error(`Agentic loop did not submit fix after ${MAX_TURNS} turns`);
}

// ── Context compaction ──────────────────────────────────────────────────────

const COMPACT_THRESHOLD = 500; // chars — tool results shorter than this are kept as-is

function compactMessages(messages: AIMessage[]): void {
  // Keep first message (error context) and last 4 messages (recent turns) intact.
  // Compact everything in between by replacing large tool_result contents with summaries.
  const keepHead = 1;
  const keepTail = 4;
  if (messages.length <= keepHead + keepTail) return;

  for (let i = keepHead; i < messages.length - keepTail; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || typeof msg.content === "string") continue;

    const blocks = msg.content as ContentBlock[];
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j] as ToolResultBlock;
      if (block.type !== "tool_result") continue;
      if (typeof block.content !== "string") continue;
      if (block.content.length <= COMPACT_THRESHOLD) continue;

      // Replace large tool result with a summary line
      const lines = block.content.split("\n").length;
      const chars = block.content.length;
      (blocks[j] as ToolResultBlock).content = `(compacted: ${lines} lines, ${chars} chars — content already processed in earlier turns)`;
    }
  }
}
