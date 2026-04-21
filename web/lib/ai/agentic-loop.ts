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
    name: "think",
    description: `Record a short planning thought WITHOUT side effects. Use this before any risky or non-trivial apply_patch to lay out: (a) the minimum set of lines you will change, (b) why this fix is correct end-to-end, (c) what could regress. The thought is logged to the admin drilldown and then the loop continues — you still need to call apply_patch / submit_fix to act. Keep it tight (≤ 200 words). Do NOT use think in place of actually reading a file or running search_code.`,
    input_schema: {
      type: "object",
      properties: {
        thought: { type: "string", description: "The reasoning to record (≤ 200 words)." },
        confidence: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Self-rated confidence that the plan will actually fix the bug without regression.",
        },
      },
      required: ["thought"],
    },
  },
  {
    name: "apply_patch",
    description: `PREFERRED terminal tool. Emit a patch envelope — GPT-5.x was trained on this format, it is much smaller than rewriting whole files, and the hunk-level context protects against accidental over-edit. This ENDS the loop; the parsed patch is applied against the files you read via read_file (the system reads originals through the GitHub API).

Envelope format:

*** Begin Patch
*** Update File: path/to/file.ts
@@ optional function name or section header (helps disambiguate if the same -/+ block appears more than once)
 unchanged context line (leading SINGLE space)
-line to remove
+line to add
 more context
*** Add File: path/to/new-file.ts
+line one
+line two
*** End Patch

Rules:
- Context lines MUST start with ONE space. Every context line MUST match the file byte-for-byte (trailing whitespace on blank lines is normalized for you).
- Include 1-3 context lines above and below each change.
- Multiple hunks per file, multiple files per patch — all allowed.
- "Add File" fails if the path exists. "Update File" fails if it doesn't.`,
    input_schema: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Brief summary of the fix (1-2 sentences for the PR description)" },
        patch: { type: "string", description: "Full patch envelope starting with '*** Begin Patch' and ending with '*** End Patch'" },
      },
      required: ["explanation", "patch"],
    },
  },
  {
    name: "submit_fix",
    description: "FALLBACK terminal tool — prefer apply_patch. This ENDS the loop. For each changed file, use '// ... keep existing code ...' markers for any unchanged block of 4+ lines — only output the lines you changed plus 1-2 lines of surrounding context. The system will expand markers against the original file.",
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
  /** Cheap model used by the post-apply verifier (PR #6). */
  verifyModel?: string;
  /** Root-cause diagnosis text — fed into the verifier sanity gate. */
  diagnosisText?: string;
  /**
   * Replay V2 session id, when this remediation was triggered from a
   * browser session recording. Threaded into the substrate replay gate
   * so the analyst sees the user's exact click → http → db → error
   * chain alongside the raw I/O recording. Tenancy-scoped by projectId
   * at the loader level — safe to pass an untrusted value.
   */
  replaySessionId?: string;
  /**
   * Files the caller has already fetched (PR #7 context pre-fetch).
   * Populate the `filesRead` cache before turn 1 so the model can skip
   * the opening read_file round-trip and start reasoning or emitting
   * a patch straight away. Keys are repo-relative paths.
   */
  prefetchedFiles?: Map<string, string>;
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

    case "think": {
      // Non-terminal scratchpad. The thought is surfaced to admin via emit()
      // (already called by the caller above). This executor just acks so the
      // Responses API has a function_call_output to pair with the call_id.
      const thought = (input.thought ?? "").trim();
      const confidence = input.confidence ?? "medium";
      if (!thought) {
        return "Error: `thought` is required and cannot be empty.";
      }
      if (thought.length > 4000) {
        return "Error: thought too long (> 4000 chars). Keep it ≤ 200 words.";
      }
      return `(recorded — confidence=${confidence}. Continue with the next tool call; remember the loop ends only when you call apply_patch or submit_fix.)`;
    }

    case "apply_patch": {
      // Terminal — parse + apply the envelope against file contents read
      // via read_file (cached in filesRead). Build the files[] payload the
      // rest of the pipeline expects.
      const patchText = (tool.input as { patch?: string }).patch;
      const explanation = (tool.input as { explanation?: string }).explanation ?? "";
      if (!patchText) return JSON.stringify({ error: "patch is required" });

      const { parsePatch, applyPatch: runApply, ApplyPatchError } = await import("./apply-patch");
      let parsed;
      try {
        parsed = parsePatch(patchText);
      } catch (e) {
        const msg = e instanceof ApplyPatchError ? e.message : String(e);
        return JSON.stringify({
          error: `Parse failed: ${msg}`,
          hint: "Check envelope syntax; retry with a valid patch.",
        });
      }

      // Pre-validate paths so we surface blocklist errors early.
      for (const op of parsed.ops) {
        if (isBlockedFile(op.path)) {
          return JSON.stringify({ error: `Access denied: ${op.path} is protected.` });
        }
      }

      // Read helper: read_file tool already cached hits in filesRead. For
      // patches that touch files the model didn't read, fall back to a
      // fresh GitHub fetch so the patch still applies.
      const readFromCacheOrGithub = async (p: string): Promise<string | null> => {
        const cached = filesRead.get(p);
        if (cached !== undefined) return cached;
        const content = await gh.getFileContent(token, owner, repo, p, defaultBranch);
        if (content !== null) filesRead.set(p, content);
        return content;
      };

      let applied;
      try {
        applied = await runApply(parsed, readFromCacheOrGithub);
      } catch (e) {
        const msg = e instanceof ApplyPatchError ? e.message : String(e);
        return JSON.stringify({
          error: `Apply failed: ${msg}`,
          hint: "Re-read the file and try again with correct context lines.",
        });
      }

      // Filter out delete-ops — downstream push path doesn't handle deletes
      // for this code path yet; surface a clear error if the model tried.
      for (const c of applied.changed) {
        if (c.op === "delete") {
          return JSON.stringify({
            error: `Delete File is not supported on this path yet; keep changes to update/add.`,
          });
        }
      }

      return JSON.stringify({
        explanation,
        files: applied.changed.map((c) => ({ path: c.path, content: c.content })),
      });
    }

    case "submit_fix": {
      // Terminal — return the fix payload as-is for the caller to process
      return JSON.stringify({ explanation: input.explanation, files: (tool.input as { files: unknown[] }).files });
    }

    default:
      return `Unknown tool: ${tool.name}`;
  }
}

/**
 * Run all sibling (non-terminal) tool_uses that shared an assistant turn
 * with a terminal tool (apply_patch / submit_fix), and return their
 * tool_result blocks so the caller can bundle them into the next user
 * message. Every tool_use id MUST get a matching tool_result, otherwise
 * downstream APIs (Chat Completions + Responses) reject the conversation.
 */
async function executeSiblingTools(
  siblings: ToolUseBlock[],
  params: AgenticLoopParams,
  filesRead: Map<string, string>,
  turn: number,
  emit: AgenticLoopParams["emit"],
): Promise<ToolResultBlock[]> {
  if (siblings.length === 0) return [];
  const results: ToolResultBlock[] = [];
  for (const s of siblings) {
    try {
      emit("agentic_tool", { turn, tool: s.name, input: s.input });
      const out = await executeTool(s, params, filesRead);
      results.push({ type: "tool_result", tool_use_id: s.id, content: out });
    } catch (err) {
      results.push({
        type: "tool_result",
        tool_use_id: s.id,
        content: `Error running ${s.name}: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      });
    }
  }
  return results;
}

/**
 * Build the inline pre-fetched-files section appended to the seed
 * message. Includes each file's full body (up to a per-file cap) so
 * the model does not feel it needs to call read_file to "look".
 * Anything past the total-bytes budget gets summarized as a listing;
 * the read_file tool will still serve those from cache on demand.
 */
function buildPrefetchPayload(prefetched: Map<string, string> | undefined): string {
  if (!prefetched || prefetched.size === 0) return "";

  const MAX_TOTAL_BYTES = 18_000;
  const MAX_PER_FILE_BYTES = 6_000;

  const fullyInlined: { path: string; body: string }[] = [];
  const listedOnly: string[] = [];
  let used = 0;

  for (const [path, content] of prefetched) {
    const slice = content.slice(0, MAX_PER_FILE_BYTES);
    const cost = slice.length + path.length + 30; // fence + header overhead
    if (used + cost > MAX_TOTAL_BYTES) {
      listedOnly.push(path);
      continue;
    }
    fullyInlined.push({ path, body: slice });
    used += cost;
  }

  const langHint = (p: string): string =>
    p.endsWith(".tsx") ? "tsx"
      : p.endsWith(".ts") || p.endsWith(".cts") || p.endsWith(".mts") ? "ts"
        : p.endsWith(".jsx") ? "jsx"
          : p.endsWith(".js") || p.endsWith(".cjs") || p.endsWith(".mjs") ? "js"
            : "";

  const parts: string[] = [
    "",
    "── Pre-fetched context (full file bodies) ──",
    "The files below are ALREADY loaded in your working set. DO NOT call read_file on them — their current contents are shown here byte-for-byte. Call think / apply_patch directly.",
    "",
  ];
  for (const { path, body } of fullyInlined) {
    parts.push(`### ${path}`);
    parts.push("```" + langHint(path));
    parts.push(body);
    parts.push("```");
    parts.push("");
  }
  if (listedOnly.length > 0) {
    parts.push(`(Also fetched but omitted from this message to save tokens — read_file will return instantly from cache: ${listedOnly.join(", ")})`);
    parts.push("");
  }
  parts.push("── End pre-fetched context ──");
  return parts.join("\n");
}

// ── Build System Prompt ─────────────────────────────────────────────────────

function buildAgenticBasePrompt(): string {
  return `You are an expert software engineer fixing a production bug.

You have tools to explore the repository: read files, search code, list directories.
When you understand the bug and know how to fix it, emit a patch.

STRATEGY:
1. Read the file(s) mentioned in the error stack trace
2. Check imports to understand what libraries the project uses
3. Read package.json if you need to know the tech stack
4. Look for existing correct patterns in the same file or nearby files
5. If a correct version of the same logic exists (e.g., in another branch of an if/else), copy that pattern
6. For non-trivial edits (more than a single-line fix, multiple files, or unusual framework semantics), call the think tool ONCE to lay out the minimal diff and what could regress. Skip this for obvious one-line null-check / typo fixes.
7. When confident, call apply_patch with a small envelope that surgically fixes the bug. Only use submit_fix as a fallback for full-file rewrites.

RULES:
- NEVER re-read a file you already read in this session. Refer to the content from your previous read_file call. Re-reading wastes time and budget.
- NEVER read files just to "verify" — you already have the content. Only re-read if you need a file you haven't seen yet.
- PREFER apply_patch over submit_fix. The envelope format is what GPT-5.x was trained on and produces smaller, safer edits.
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

  // Base prompt (workflow + rules). The model-aware wrapper runs per turn
  // below — applies GPT overlays + IMMUTABLE_RULES dual-point pattern.
  const { buildGPTRemediationSystemPrompt } = await import("./prompts");
  const basePrompt = buildAgenticBasePrompt();

  // Track files read across turns — serves cached content on re-reads,
  // saving GitHub API calls and preventing wasted turns. Seeded with
  // prefetchedFiles from the caller (PR #7) so the model can skip the
  // opening read_file round-trip when the diagnose step already fetched
  // the bug file + its direct imports.
  const filesRead = new Map<string, string>();
  if (params.prefetchedFiles) {
    for (const [path, content] of params.prefetchedFiles) {
      filesRead.set(path, content);
    }
    if (params.prefetchedFiles.size > 0) {
      emit("agentic_prefetch", {
        count: params.prefetchedFiles.size,
        paths: Array.from(params.prefetchedFiles.keys()).slice(0, 10),
      });
    }
  }

  // Stall detection — if the agent re-reads the same files or makes no
  // progress for 3 consecutive turns, abort early to save budget.
  const MAX_STALL_TURNS = 3;
  let stallCount = 0;
  let lastToolSignature = "";

  // Start with the error context. When the caller pre-fetched files
  // (PR #7), INLINE their contents in the seed message so the model can
  // reason about them on turn 1 without calling read_file. Merely
  // listing paths was not enough — E2E v9 showed gpt-4o-mini still
  // read_file'd each listed path "to check", burning turns.
  //
  // We cap total inlined bytes so a big pre-fetch doesn't blow up the
  // first-turn prompt cost. Anything over the cap is summarized as a
  // listing and the agent can read_file on demand (it'll hit the
  // warm cache anyway).
  const prefetchPayload = buildPrefetchPayload(params.prefetchedFiles);
  const messages: AIMessage[] = [
    { role: "user", content: errorContext + prefetchPayload },
  ];

  // Responses API threading (GPT-5.x, store:false mode). Each turn returns
  // the raw `output` items — we forward them in the next turn's input so
  // reasoning.encrypted_content stays paired with its function_call items.
  // Without this the model loses reasoning context between tool calls
  // (Cursor measured ~30% regression when dropped).
  let priorOutput: Array<Record<string, unknown>> | undefined;
  const { effortForTurn } = await import("./openai-config");

  // Per-session memory of failed apply_patch attempts. When the model
  // emits a 2nd / 3rd patch that fails for a similar reason to a prior
  // one, we include a "do not repeat" hint in the tool_result so the
  // next turn has visibility into its own history.
  const { RetryMemory } = await import("./retry-memory");
  const retryMemory = new RetryMemory();

  // Verifier-gate retry budget (PR #6). Post-apply sanity checks can
  // bounce a patch back for correction, but we cap the back-and-forth
  // so a stubborn verifier failure doesn't eat the whole turn budget.
  const MAX_VERIFIER_RETRIES = 2;
  let verifierRetries = 0;

  // Substrate replay gate retry budget. The replay gate reasons about
  // whether the patch would prevent the I/O sequence that was recorded
  // before the crash — unique signal the static gates cannot produce.
  // Same cap philosophy as the verifier: two bounce-backs, then we skip
  // (advisory) so a stubborn recording + model disagreement doesn't
  // thrash the turn budget. Downstream auto-merge gate #9 remains the
  // authoritative post-push check.
  const MAX_REPLAY_RETRIES = 2;
  let replayRetries = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    emit("agentic_turn", { turn, maxTurns: MAX_TURNS });

    // Two-stage context compaction.
    //
    // Stage 1 (light, in-place): at turn 9, shrink bulky tool_result
    // contents from earlier turns — the model has already "read" them
    // and the raw file bytes are no longer load-bearing. This preserves
    // tool_use / tool_result pairing AND keeps the priorOutput chain
    // valid, so we don't lose reasoning continuity.
    if (turn === 9 && messages.length > 6) {
      compactMessages(messages);
      emit("agentic_compacted", { turn, messageCount: messages.length, stage: "light" });
    }

    // Stage 2 (heavy, structural): when the message array grows past
    // threshold — typically because of multiple apply_patch retries or
    // a stubborn bug needing deep exploration — rewrite the middle as a
    // prose digest and drop priorOutput. This loses encrypted reasoning
    // chain but prevents unbounded context growth.
    const { shouldCompact: shouldHeavy, compactMessages: compactHeavy } = await import("./context-compaction");
    if (shouldHeavy(messages, { thresholdMessages: 18 })) {
      const result = compactHeavy(messages, { thresholdMessages: 18, keepLastTurns: 4 });
      messages.length = 0;
      messages.push(...result.messages);
      priorOutput = undefined;
      emit("agentic_compacted", {
        turn,
        messageCount: messages.length,
        stage: "heavy",
        compactedFrom: result.compactedFrom,
        compactedTo: result.compactedTo,
      });
    }

    // Use explore model (Haiku — cheap) for exploration, fix model (Sonnet — quality) for the last 3 turns
    // This allows the AI to explore cheaply and generate quality fixes
    const isNearEnd = turn > MAX_TURNS - 3;
    const currentModel = isNearEnd ? fixModel : exploreModel;

    // Compose model-aware system prompt per turn.
    const systemPrompt = buildGPTRemediationSystemPrompt(basePrompt, currentModel);

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

    // Check for terminal tools first (apply_patch preferred; submit_fix fallback).
    const applyPatchCall = toolUses.find((t) => t.name === "apply_patch");
    if (applyPatchCall) {
      const fullPatch = (applyPatchCall.input as { patch?: string }).patch ?? "";
      const patchPreview = fullPatch.slice(0, 200);
      emit("agentic_tool", { turn, tool: "apply_patch", input: { patch: fullPatch, patchPreview } });
      const result = await executeTool(applyPatchCall, params, filesRead);
      const parsed = JSON.parse(result) as
        | { explanation: string; files: { path: string; content: string }[] }
        | { error: string; hint?: string };

      // If parse/apply failed, surface the error back to the model as a
      // tool_result and continue the loop — don't terminate on a bad patch.
      //
      // The assistant may have emitted OTHER tool_use blocks in the same
      // turn (e.g. think + apply_patch). Every tool_use id MUST have a
      // matching tool_result in the next user message, or Chat Completions
      // (gpt-4o-mini path) 400s with "tool_call_ids without response".
      // Execute the sibling non-terminal tools now and bundle all results
      // into a single user message.
      if ("error" in parsed) {
        emit("agentic_error", { turn, tool: "apply_patch", error: parsed.error });
        // Build a retry hint from prior failures BEFORE recording this one,
        // so the hint describes "attempts PRIOR to this one" — less confusing.
        const retryHint = retryMemory.buildHint();
        retryMemory.record(turn, fullPatch, parsed.error);

        const siblingResults = await executeSiblingTools(
          toolUses.filter((t) => t.id !== applyPatchCall.id),
          params,
          filesRead,
          turn,
          emit,
        );
        const content = [
          `apply_patch error: ${parsed.error}`,
          parsed.hint ? `Hint: ${parsed.hint}` : "",
          retryHint,
        ]
          .filter(Boolean)
          .join("\n");
        messages.push({
          role: "user",
          content: [
            ...siblingResults,
            {
              type: "tool_result",
              tool_use_id: applyPatchCall.id,
              content,
              is_error: true,
            } as ToolResultBlock,
          ] as ContentBlock[],
        });
        continue;
      }

      // ── Verifier gate (PR #6) ─────────────────────────────────────
      // Pre-push sanity: make sure the patched files parse + the fix
      // plausibly addresses the error. Uses the CURRENT file cache
      // (the originals we've been operating against) as the "before".
      //
      // The LLM-backed sanity gate is rate-limited by MAX_VERIFIER_RETRIES
      // (cost + latency concern). But the deterministic gates — syntax
      // parse and mechanical pattern checks — are essentially free, so
      // we keep them running on EVERY apply_patch success. Shipping a
      // fix that doesn't even parse is worse than one more cheap retry.
      try {
        const { verifyFix } = await import("./verifier");
        const verifyModel = params.verifyModel ?? params.exploreModel;
        const atLLMCap = verifierRetries >= MAX_VERIFIER_RETRIES;
        const result = await verifyFix({
          files: parsed.files,
          originalFiles: filesRead,
          errorContext: params.errorContext,
          diagnosis: params.diagnosisText ?? "(diagnosis unavailable)",
          apiKey,
          model: verifyModel,
          // At the cap, drop the expensive sanity LLM call but keep
          // syntax + mechanical — those are deterministic + free.
          skipSanity: atLLMCap,
          log: params.log
            ? {
                userId: params.log.userId,
                projectId: params.projectId,
                alertId: params.log.alertId,
                remediationSessionId: params.log.remediationSessionId,
                isPlatformKey: params.log.isPlatformKey,
              }
            : undefined,
        });
        emit("agentic_verify", {
          turn,
          ok: result.ok,
          severity: result.severity,
          issue: result.issue,
          cap: atLLMCap ? "sanity-skipped" : undefined,
        });
        if (!result.ok) {
          // Deterministic gate failure (syntax / mechanical) must block
          // regardless of cap — shipping a non-compiling fix is worse
          // than one more in-loop turn. Only the LLM sanity gate uses
          // the cap, and skipSanity above prevents those from firing
          // past MAX_VERIFIER_RETRIES anyway.
            verifierRetries++;
            const verifierHint = [
              `apply_patch PARSED cleanly but the post-apply verifier REJECTED the result and rolled it back. The files on disk are still the ORIGINALS — nothing was applied.`,
              "",
              `Rejection reason (severity=${result.severity}):`,
              `  ${result.issue}`,
            "",
            `Next step: emit a COMPLETE apply_patch again (every file, every hunk, not just a "correction"), paying close attention to the issue above. The previous patch is discarded. Re-read any file if you need to refresh the byte-exact context lines.`,
          ].join("\n");
          const siblingResults = await executeSiblingTools(
            toolUses.filter((t) => t.id !== applyPatchCall.id),
            params,
            filesRead,
            turn,
            emit,
          );
          messages.push({
            role: "user",
            content: [
              ...siblingResults,
              {
                type: "tool_result",
                tool_use_id: applyPatchCall.id,
                content: verifierHint,
                is_error: true,
              } as ToolResultBlock,
            ] as ContentBlock[],
          });
          continue;
        }
      } catch (verr) {
        // Verifier runtime failure — advisory, never blocks.
        emit("agentic_verify", {
          turn,
          ok: true,
          severity: "warning",
          issue: `verifier runtime error: ${verr instanceof Error ? verr.message.slice(0, 100) : "unknown"}`,
        });
      }

      // ── Substrate replay gate (pre-push, in-loop) ────────────────
      // After the static gates pass, ask the replay analyst whether
      // the patch would prevent the I/O sequence Substrate recorded
      // before the crash. The analyst sees the real HTTP / DB / file
      // ops that led to the failure — a different signal than the
      // sanity gate, which only sees the diff + stack trace.
      //
      // This is the VAR signal: "verifiable" remediation means we can
      // show evidence the fix addresses the recorded failure path,
      // not just that the code parses + reads correctly.
      //
      // Blocking within MAX_REPLAY_RETRIES: a rejection kicks the
      // model back for another turn with the analyst's reasoning in
      // the tool_result. Past the cap we skip (advisory). Downstream
      // auto-merge gate #9 re-runs the same analysis post-push and is
      // the authority if the disagreement persists.
      const replayAlertId = params.log?.alertId ?? null;
      const replayUserId = params.log?.userId;
      if (replayAlertId && replayUserId && replayRetries < MAX_REPLAY_RETRIES) {
        try {
          const { analyzeReplay } = await import("./substrate-replay");
          const replayModel = params.verifyModel ?? params.exploreModel;
          const replay = await analyzeReplay(
            params.projectId,
            replayAlertId,
            params.diagnosisText ?? "(diagnosis unavailable)",
            parsed.files,
            apiKey,
            provider,
            replayModel,
            {
              userId: replayUserId,
              remediationSessionId: params.log?.remediationSessionId ?? undefined,
              isPlatformKey: params.log?.isPlatformKey,
            },
            params.replaySessionId,
          );

          if (replay === null) {
            // No Substrate recording for this alert / project — gate
            // is advisory, let the fix through.
            emit("agentic_replay", { turn, skipped: true, reason: "no_recording" });
          } else {
            emit("agentic_replay", {
              turn,
              passed: replay.passed,
              confidence: replay.confidence,
              riskScore: replay.riskScore,
              replayedEvents: replay.replayedEvents,
              analysis: replay.analysis.slice(0, 200),
              replayContextUsed: replay.replayContextUsed,
              mode: replay.mode,
            });

            if (!replay.passed) {
              replayRetries++;
              const replayHint = [
                `apply_patch PARSED cleanly and PASSED syntax + mechanical + sanity gates, but the SUBSTRATE REPLAY gate REJECTED the result and rolled it back. The files on disk are still the ORIGINALS — nothing was applied.`,
                ``,
                `The replay analyst reviewed the production I/O sequence Substrate recorded right before the crash — HTTP requests, DB queries, file operations — and concluded this fix would NOT prevent the same failure.`,
                ``,
                `Verdict: risk ${replay.riskScore}/100 (needed ≤ 40), confidence ${replay.confidence}/100, ${replay.replayedEvents} recorded events analyzed.`,
                ``,
                `Analyst reasoning:`,
                `  ${replay.analysis}`,
                ``,
                `Next step: re-think the failure path using the recorded I/O above. Re-read any file you need; the previous patch is discarded. Then emit a COMPLETE apply_patch (every file, every hunk) that addresses the specific operations the analyst flagged.`,
              ].join("\n");
              const siblingResults = await executeSiblingTools(
                toolUses.filter((t) => t.id !== applyPatchCall.id),
                params,
                filesRead,
                turn,
                emit,
              );
              messages.push({
                role: "user",
                content: [
                  ...siblingResults,
                  {
                    type: "tool_result",
                    tool_use_id: applyPatchCall.id,
                    content: replayHint,
                    is_error: true,
                  } as ToolResultBlock,
                ] as ContentBlock[],
              });
              continue;
            }
          }
        } catch (rerr) {
          // Runtime failure (network, DB, AI error, parse) — advisory,
          // never blocks. Matches the verifier's behavior when the
          // sanity gate can't run.
          emit("agentic_replay", {
            turn,
            skipped: true,
            reason: "runtime_error",
            error: rerr instanceof Error ? rerr.message.slice(0, 200) : "unknown",
          });
        }
      } else if (!replayAlertId || !replayUserId) {
        emit("agentic_replay", { turn, skipped: true, reason: "no_alert_context" });
      } else {
        emit("agentic_replay", { turn, skipped: true, reason: "retry_cap" });
      }

      emit("agentic_done", { turns: turn, files: parsed.files.map((f) => f.path), via: "apply_patch" });
      return { explanation: parsed.explanation, files: parsed.files, turns: turn };
    }

    const submitFix = toolUses.find((t) => t.name === "submit_fix");
    if (submitFix) {
      emit("agentic_tool", { turn, tool: "submit_fix", input: { files: ((submitFix.input as { files?: { path: string }[] }).files ?? []).map((f) => f.path) } });
      const result = await executeTool(submitFix, params, filesRead);
      const fix = JSON.parse(result) as { explanation: string; files: { path: string; content: string }[] };
      const expandedFiles = expandFixFiles(fix.files, filesRead);
      emit("agentic_done", { turns: turn, files: expandedFiles.map((f) => f.path), via: "submit_fix" });
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
