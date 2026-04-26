# Programmatic Tool Calling (PTC) — Implementation Plan for InariWatch

> **Handoff document.** Read top-to-bottom before taking any action. You are a fresh session of Claude Opus 4.7 with **no prior memory** of this codebase. This document is the ONLY source of truth for this task. Do NOT invent context — verify everything against the files mentioned.

**Target branch:** feature branch off `main` (name: `feat/ptc-container-agent`)
**Estimated effort:** 10-14 days of focused work
**Difficulty:** medium-high (requires careful API integration + safety review)
**Owner:** Jesus Bernal (@JesusBrDev), solo founder
**Date plan written:** 2026-04-21

---

## 0. What you need to know before starting

### 0.1 What is InariWatch

InariWatch is an AI-powered production monitoring SaaS. It ingests alerts from external services (Sentry, Vercel, GitHub, Datadog, Expo) and from the user's own app via `@inariwatch/capture` SDK, then runs an **AI remediation pipeline** that diagnoses the bug, generates a fix, verifies it in a container, pushes to GitHub, and auto-merges if safety gates pass.

- Product URL: `app.inariwatch.com`
- Stack: Next.js 15 (App Router), TypeScript, PostgreSQL (Neon) + Drizzle, Kamal 2 deployment on Hetzner, multi-provider AI (Anthropic Claude, OpenAI GPT, Groq, Grok, DeepSeek, Gemini)
- Repo structure: monorepo with `web/` (Next.js app), `worker/` (Hetzner Node.js worker), `cli/` (Rust CLI), `capture/` (npm SDK), more

### 0.2 The container agent (what you'll be modifying)

The heart of the remediation pipeline is the **container agent**: a multi-turn AI loop that clones the user's repo into a Docker container, explores the code with tools, generates a fix, verifies with `tsc + build + test`, and pushes to GitHub.

It runs in two modes:
1. **Worker mode** (`worker/src/container-agent.ts`): AI loop runs on a Hetzner Node.js worker, Docker on localhost (~1ms tool calls), up to **40 turns**. Production default when `WORKER_URL` is set.
2. **Vercel mode** (`web/lib/ai/container-agent.ts`): Fallback when worker is unavailable. Same logic, Docker calls go over HTTPS to Hetzner staging server (~80-120ms per tool call), up to **15 turns** (Vercel has 60s per-request timeout).

You will primarily modify **worker mode**. Keep Vercel mode working but do not require PTC there.

### 0.3 Your environment

```bash
# Clone the repo (assumes you have read access)
git clone https://github.com/orbita-pos/inariwatch.git
cd inariwatch
git checkout -b feat/ptc-container-agent

# Primary working directory
cd worker/        # for container agent worker changes
cd web/           # for AI client, prompts, shared types

# Key files you'll read first (DO THIS before writing code)
cat worker/src/container-agent.ts
cat worker/src/ai-client.ts
cat web/lib/ai/container-agent.ts
cat web/lib/ai/client.ts
cat web/lib/ai/prompts.ts
cat web/lib/ai/models.ts
cat web/lib/ai/agentic-loop.ts
```

### 0.4 What's being asked of you

Implement **Programmatic Tool Calling (PTC)** — a new Anthropic Advanced Tool Use feature — in the container agent, as an **opt-in** capability for Anthropic Sonnet 4.5+. The goal is to reduce the number of LLM turns per remediation by ~3-5× while preserving exact behavioral compatibility for non-Anthropic providers and for Anthropic users who haven't opted in.

**Out of scope for this task:** migrating Vercel mode to PTC, adding PTC to GPT-5.x / other providers, changing the auto-merge gates or the 17-gate evaluation logic.

---

## 1. The Anthropic feature we're adopting

### 1.1 Authoritative reference material (READ FIRST)

**Primary source (required reading):**
- Anthropic Engineering post: https://www.anthropic.com/engineering/advanced-tool-use
- Prompt Caching docs (for orthogonal optimization): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Tool Use docs: https://platform.claude.com/docs/en/build-with-claude/tool-use
- Building Effective Agents (design principles): https://www.anthropic.com/engineering/building-effective-agents

**Secondary (for prototyping):**
- Anthropic cookbook on GitHub for PTC examples — search "anthropic cookbook programmatic tool calling"
- Anthropic SDK for TypeScript: https://github.com/anthropics/anthropic-sdk-typescript

### 1.2 What Programmatic Tool Calling is (verified 2026-04-21)

In standard tool use:
- Model emits a `tool_use` block with name + input
- Client executes the tool, returns `tool_result`
- Model sees result, emits next `tool_use` — and so on, N times
- N tool calls = N round-trips to the LLM = N × (TTFT + output time)

In Programmatic Tool Calling:
- Client declares tools with `allowed_callers: ["code_execution_20250825"]` in addition to declaring the `code_execution` tool itself
- Model emits a **single** `code_execution` block containing **Python code** that orchestrates multiple tool calls via function-like invocations (`await tool_name(...)`)
- The Python runs in **Anthropic's managed sandbox** (client does NOT host the interpreter)
- **Tool calls from within the Python still come back to the client to execute** (via `code_execution_tool_result` events). The client executes each tool and returns results to Anthropic's sandbox.
- When Python finishes, the aggregated result is returned to Claude as a **single** observation
- **Critical consequence:** intermediate tool results never enter Claude's context — they're consumed inside the Python. Only the final return value (and any uncaught errors) are seen by Claude.

### 1.3 API shape (verified from https://www.anthropic.com/engineering/advanced-tool-use)

Required request additions when calling the Anthropic Messages API:

```jsonc
{
  "model": "claude-sonnet-4-5-20250929",
  "betas": ["advanced-tool-use-2025-11-20"],
  "tools": [
    {
      "type": "code_execution_20250825",
      "name": "code_execution"
    },
    {
      "name": "read_file",
      "description": "...",
      "input_schema": { /* ... */ },
      "allowed_callers": ["code_execution_20250825"]
    },
    {
      "name": "run_command",
      "description": "...",
      "input_schema": { /* ... */ },
      "allowed_callers": ["code_execution_20250825"]
    }
    // ... all other tools must opt-in via allowed_callers
  ],
  "messages": [ /* ... */ ]
}
```

Response contains:
- `content[].type: "code_execution"` — the Python block the model wrote
- Followed by `code_execution_tool_result` events streamed as tools are invoked from inside the Python

### 1.4 Which models support PTC

**Verified (official Anthropic example):** `claude-sonnet-4-5-20250929`

**Probable but must verify before coding:** `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. Opus 4.7 status unknown.

**Action for you**: before implementation, send one test request per candidate model with the beta header and confirm it doesn't 400-error. If Sonnet 4.6 doesn't support PTC, use Sonnet 4.5 for the fix-generation turn only.

### 1.5 Limitations documented by Anthropic

From the post, verbatim: PTC is "less beneficial when: Making simple single-tool invocations" or "where Claude should see and reason about all intermediate results."

**Implication for us**: PTC is not a wholesale replacement for the current loop. It's valuable for **multi-step verification flows** (read → patch → tsc → read error → patch → tsc → pass) but not for the single-call pattern (e.g., a one-shot `apply_patch` where the model doesn't need to orchestrate anything).

---

## 2. Current state (what you'll be modifying)

### 2.1 Current architecture

The container agent lives in two files with near-identical logic:

```
worker/src/container-agent.ts     (568 lines, MAX_TURNS=40, production)
web/lib/ai/container-agent.ts     (919 lines, MAX_TURNS=15, Vercel fallback)
```

Both files:
1. Create a Docker container on Hetzner (via HTTPS to the Go staging server at port 9400)
2. Clone the user's repo into the container
3. Run an AI loop: model sees context → emits tool_use → client executes tool in container → model sees result → repeat
4. Terminate when the model calls `submit_fix` (or max turns reached)
5. Return the final file changes to the caller

### 2.2 Current tool set (8 tools)

From `worker/src/container-agent.ts` around lines 100-110:

| Tool | Purpose | Side effects |
|---|---|---|
| `think` | Record planning thought (no side effect) | None |
| `read_file` | Read file contents, capped at 15k chars | None |
| `search_code` / `grep` | Search patterns in repo | None |
| `list_directory` | List dir contents | None |
| `apply_patch` | Apply unified-diff patch (GPT-5.x envelope format) | Writes files |
| `write_file` | Write complete file (fallback, prefer apply_patch) | Writes files |
| `run_command` | Run shell: npm/npx/node/tsc/git/cat/ls/grep/find/mkdir/cp/head/tail/wc/diff/echo/pwd/which/pnpm/yarn/bun | Executes in container |
| `submit_fix` | Signal fix complete (terminal) | Terminates loop |

Allowed commands are whitelisted (`ALLOWED_COMMANDS` const). Blocked patterns include subshells, backticks, semicolons, `sudo`, `chmod`, `curl`, etc. Do not change this safety posture.

### 2.3 Current loop flow (simplified)

```typescript
// worker/src/container-agent.ts lines ~430-560
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const response = await callAIWithTools(aiKey, systemPrompt, messages, CONTAINER_TOOLS, { ... });
  const toolUses = response.content.filter(b => b.type === "tool_use");
  const toolResults = [];
  for (const toolUse of toolUses) {
    const result = await executeContainerTool(toolUse, containerId);
    toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
  }
  messages.push({ role: "assistant", content: response.content });
  messages.push({ role: "user", content: toolResults });
  if (toolUses.some(t => t.name === "submit_fix")) break;
}
```

### 2.4 Current baseline metrics (measure these before changing anything)

You must measure these on 5-10 real remediations BEFORE and AFTER for the eval:
- Average turns per remediation (expected range: 15-35)
- Average wall time per remediation (expected: 60-180s for agent loop alone, excluding CI wait)
- Average cost per remediation (expected: ~$0.25)
- Success rate (submit_fix called and tsc+build pass): expected 70-85%

Query these from the database:
```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) AS avg_wall_sec,
  AVG((
    SELECT COUNT(*)
    FROM jsonb_array_elements(steps) elem
    WHERE elem->>'type' = 'container_turn'
  )) AS avg_turns
FROM remediation_sessions
WHERE created_at > NOW() - INTERVAL '30 days';
```

---

## 3. Target architecture

### 3.1 High-level flow (with PTC enabled)

```typescript
// New pseudo-flow
async function runContainerAgentPTC(params) {
  const containerId = await createContainer(params);
  const usePTC = isPTCCapable(params.fixModel) && params.ptcEnabled;

  // The system prompt is slightly different for PTC:
  // - Instructs the model to write Python that orchestrates multiple tool calls
  // - Tells the model the tool functions are available as async Python functions
  const systemPrompt = usePTC
    ? buildPTCSystemPrompt(basePrompt)
    : buildStandardSystemPrompt(basePrompt);

  const tools = usePTC ? toolsWithAllowedCallers : CONTAINER_TOOLS;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await callAIWithTools(aiKey, systemPrompt, messages, tools, {
      betas: usePTC ? ["advanced-tool-use-2025-11-20"] : undefined,
      codeExecutionEnabled: usePTC,
      ...
    });

    if (usePTC && response.hasCodeExecution) {
      // Handle code_execution_tool_result stream: execute each inner tool call,
      // feed results back to Anthropic's sandbox, await final aggregated result
      const ptcResult = await handlePTCExecution(response, containerId);
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: [{ type: "code_execution_result", ... }] });
    } else {
      // Existing path (unchanged)
      const toolResults = await executeStandardToolUses(response, containerId);
      messages.push(...);
    }

    if (response.submittedFix) break;
  }

  return { files, turnsUsed, usedPTC };
}
```

### 3.2 Key design decisions

1. **Opt-in flag**: `remediationSessions.context.ptcEnabled` (JSON field already exists). Default `false`. Flip to `true` per-project or via a global kill-switch env var `PTC_ENABLED_FOR_PROJECTS=proj1,proj2`.
2. **Same tool definitions**: the tool names, descriptions, and schemas do NOT change. Only the request-level declaration changes (adding `code_execution_20250825` tool + `allowed_callers` on the rest).
3. **Client still executes tools**: you are NOT building a Python interpreter. Anthropic hosts the sandbox. Inner tool calls still come back to your client exactly like today.
4. **Backwards-compat for non-Anthropic providers**: if the model is OpenAI / Groq / etc., do NOT send PTC metadata. The dispatcher in `worker/src/ai-client.ts` must branch on provider + model capabilities.
5. **Preserve all existing safety**: command whitelist, path traversal protection, tmpfs limits — unchanged. Inner tool calls from PTC go through the exact same `executeContainerTool()` function.
6. **Observability**: every PTC turn must log to `ai_usage_logs` with a new boolean column `used_ptc` (see migration section). InariLens (`web/lib/ai/lens.ts`) should surface this per-call.

### 3.3 What stays the same

- `auto-merge-gates.ts` (17 gates) — unchanged
- `remediate.ts` main orchestrator — unchanged except for reading the new flag
- GitHub API flow, CI wait, post-merge monitor — unchanged
- Security scan, self-review — unchanged
- Circuit breaker, concurrency locks — unchanged

---

## 4. Implementation phases

### Phase A — Research & Verification (Day 1)

**Goal**: confirm API shape, supported models, and failure modes with real requests before writing production code.

1. Read https://www.anthropic.com/engineering/advanced-tool-use top to bottom.
2. Find and clone the Anthropic cookbook: `git clone https://github.com/anthropics/anthropic-cookbook`. Find the PTC example under `tool_use/` or search for `advanced-tool-use-2025-11-20`.
3. Write a standalone prototype in `scratch/ptc-probe.ts` (NOT committed to `main`):
   - Make a real API call to `claude-sonnet-4-5-20250929` with PTC beta header
   - Declare 2 trivial tools: `read_file(path)` and `run_command(cmd)`
   - Give it a simple task: "Read `/tmp/a.txt`, count lines, run `wc -l` to verify"
   - Log the full response stream to understand the event order (`code_execution`, `code_execution_tool_result`, final message)
4. Repeat with `claude-sonnet-4-6` and `claude-haiku-4-5-20251001` to confirm support status.
5. Write findings to `scratch/ptc-findings.md` (uncommitted). Include:
   - Which models accept the beta header
   - Exact shape of `code_execution_tool_result` event
   - How inner tool calls are dispatched (are they `tool_use` blocks? something else?)
   - Token accounting: how does the model bill for Python code + inner tool calls?
   - Error behavior: what happens if Python raises? Does Claude see the traceback?
6. Verify cost: a single PTC turn with 10 inner tool calls should cost roughly the same as 10 standard turns minus 9× the system-prompt overhead. Confirm with real numbers.

**Exit criteria**: you can articulate the exact API contract in 1 page. You have 3 working prototypes against the live API.

### Phase B — Core PTC dispatch in AI client (Day 2-4)

**Goal**: add PTC-aware request building and response parsing to `worker/src/ai-client.ts` and `web/lib/ai/client.ts`.

Files to modify:
- `worker/src/ai-client.ts` — add `betas` and `allowed_callers` support to `callAIWithTools()`
- `web/lib/ai/client.ts` — mirror the same changes (keep the two files aligned)

Files to create:
- `worker/src/ptc-types.ts` — TypeScript types for PTC events (`CodeExecutionBlock`, `CodeExecutionToolResult`, etc.)
- `worker/src/ptc-handler.ts` — the event-loop that handles the stream: receives `code_execution_tool_result` events, dispatches them to the existing `executeContainerTool()`, posts results back via the SDK's continuation mechanism

Key functions to add:

```typescript
// worker/src/ai-client.ts
export interface CallAIWithToolsPTCOpts extends CallAIWithToolsOpts {
  /** Enable Programmatic Tool Calling. Requires Anthropic model >= Sonnet 4.5. */
  ptcEnabled?: boolean;
}

// New dispatcher branch:
if (opts.ptcEnabled && isPTCCapable(provider, model)) {
  return callAnthropicWithPTC(key, systemPrompt, messages, tools, opts);
}
// else: existing path
```

```typescript
// worker/src/ptc-handler.ts
export async function runPTCStream(params: {
  client: Anthropic;
  request: MessageCreateParamsStreaming;
  onInnerToolCall: (tool: ToolUseBlock) => Promise<ToolResultBlock>;
}): Promise<{
  finalMessage: Anthropic.Message;
  innerToolCalls: ToolUseBlock[];
  totalTokens: { input: number; output: number; cached: number };
}> {
  // Stream, intercept code_execution_tool_result events,
  // call onInnerToolCall for each, feed results back,
  // collect final message.
}
```

Checklist:
- [ ] Beta header is added only for Anthropic + PTC-capable model
- [ ] `allowed_callers: ["code_execution_20250825"]` is added to all non-code-execution tools
- [ ] `code_execution_20250825` tool is added to the tools array
- [ ] Streaming is used (PTC requires SSE)
- [ ] Inner tool calls flow through `executeContainerTool()` unchanged
- [ ] `ai_usage_logs` records `used_ptc=true` when applicable
- [ ] Unit tests for: beta header absent on non-PTC, beta header present on PTC, inner tool call round-trip, Python error propagation

### Phase C — Container agent integration (Day 5-7)

**Goal**: wire PTC into `worker/src/container-agent.ts` behind the opt-in flag.

Changes:
1. Read `session.context?.ptcEnabled` and the global `PTC_ENABLED_FOR_PROJECTS` env var.
2. Detect PTC capability via `isPTCCapable(exploreModel) && isPTCCapable(fixModel)`.
3. If enabled AND capable, adjust:
   - System prompt: add a PTC-specific section instructing the model to use Python orchestration when the next step has multiple dependent tool calls
   - Tool declarations: add `allowed_callers` + the `code_execution` tool
   - `callAIWithTools()` call: pass `ptcEnabled: true`
4. The inner `run_command` calls from PTC must respect `EXEC_TIMEOUT = 240` (already the default for gVisor mode).
5. Track PTC usage in `updateProgress()`:
   - New step type: `container_turn_ptc` with `detail: "Turn ${turn}/${maxTurns} (PTC, ${innerCalls} inner calls)"`
6. Keep `MAX_TURNS = 40` unchanged. PTC turns still count, but each turn does much more.

### Phase D — Prompt engineering (Day 8-9)

**Goal**: write the PTC-specific system prompt addition. Without guidance, the model won't know PTC is available or when to use it.

Add to `worker/src/container-agent.ts` in `buildBasePrompt()` (or a new `buildPTCBasePrompt()`):

```markdown
## Programmatic Tool Calling (PTC)

You have access to a `code_execution` tool that lets you write Python to orchestrate multiple tool calls in a single turn. Use it when:
- You need to read 3+ files and make decisions based on their combined content
- You need a read/verify/patch/re-verify loop (e.g., `tsc → patch → tsc`)
- You want to run parallel reads via `asyncio.gather()`
- You want to apply a batch of small patches after inspection

Do NOT use PTC for:
- Single-tool invocations (`read_file("a.ts")` alone)
- Situations where you need to stop and think between steps
- Cases where you want the user to see intermediate reasoning

Example PTC usage:

\`\`\`python
# Inside a code_execution block
import asyncio
files_to_check = ["src/auth.ts", "src/middleware.ts", "lib/session.ts"]
contents = await asyncio.gather(*[read_file(f) for f in files_to_check])

# Find which file has the null-check bug
buggy_file = None
for path, content in zip(files_to_check, contents):
    if "user.email" in content and "if (!user)" not in content:
        buggy_file = path
        break

if buggy_file:
    # Apply fix, verify
    await apply_patch(envelope)
    result = await run_command("npx tsc --noEmit")
    if result["exitCode"] == 0:
        return {"status": "verified", "file": buggy_file}
    else:
        return {"status": "tsc_failed", "error": result["stderr"]}
\`\`\`

The return value of your code is what the model sees next. Keep it compact — structured JSON is ideal.
```

Test this prompt against the golden dataset (Phase E) before calling it done.

### Phase E — Eval and rollout (Day 10-14)

**Goal**: measure that PTC actually helps on real bugs, and ship safely.

1. **Run the eval harness** (location: `web/lib/ai/evals/` if it exists; else ask Jesus where the golden-dataset v4 lives — recent commits reference it):
   - A/B: 50 bugs run twice each — once with PTC off, once with PTC on (same model, same prompts otherwise)
   - Metrics: success rate, avg turns, avg wall time, avg cost
   - Pass criteria: PTC should show ≥20% reduction in turns AND ≥15% reduction in wall time AND success rate within ±2% of non-PTC

2. **Staged rollout**:
   - Ship with `PTC_ENABLED_FOR_PROJECTS=<single internal test project>` first
   - Monitor 10 remediations
   - Expand to 5 friendly customers
   - Full opt-in UI flag after 1 week stable

3. **Rollback plan**: unset the env var. Code path continues to work with PTC disabled (the dispatcher already handles that branch).

4. **Documentation**: add a section to `CLAUDE.md` under "Remediation fix generation" describing PTC as strategy 2c (between worker mode and agentic loop).

---

## 5. Critical constraints

### 5.1 Safety

- Inner tool calls from PTC MUST go through the existing `executeContainerTool()` function. Do not add a bypass.
- The command whitelist (`ALLOWED_COMMANDS` in `worker/src/container-agent.ts`) applies transitively — if the Python calls `run_command("sudo rm -rf /")`, it must still be rejected.
- `BLOCKED_PATTERNS` (subshells, backticks, semicolons) also apply.
- `BLOCKED_FILE_PATTERNS` (.env, credentials, .pem, .key) apply to `read_file` and `write_file`.
- `BLOCKED_WRITE_PATTERNS` (lockfiles, node_modules) apply to `apply_patch` and `write_file`.
- Path traversal is already guarded. Do not change that.

### 5.2 Compatibility

- Non-Anthropic providers (OpenAI, Groq, Gemini, etc.) MUST continue to work identically. Their dispatch path should not touch any PTC code.
- Anthropic models below Sonnet 4.5 (old Opus 3, Haiku 3, etc.) MUST not receive the beta header. Use a feature-detection function.
- Vercel mode (`web/lib/ai/container-agent.ts`) should NOT enable PTC. Its 60s timeout is too tight for PTC's multi-tool orchestration. Document this decision in a code comment.

### 5.3 Observability

- Every PTC call logs to `ai_usage_logs` with `used_ptc=true`, plus the existing `duration_ms`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `feature='remediation'`.
- Add a migration to add the `used_ptc boolean NOT NULL DEFAULT false` column.
- Emit to InariLens (`lib/ai/lens.ts`) via the existing `logAICall()` helper — add `usedPTC` to its params.
- New step type `container_turn_ptc` in the `RemediationStep.type` enum (schema field is free-form string, no migration needed).
- `/admin/ops` dashboard: add a new widget showing PTC adoption rate and delta in avg turns vs non-PTC.

### 5.4 Prompt caching interaction

PTC and prompt caching compose. When using PTC:
- Cache the system prompt with `cache_control: { type: "ephemeral", ttl: "1h" }`
- Cache the tool definitions (including the `code_execution_20250825` tool declaration)
- Do NOT cache the user messages (changes per turn)

Verify in Phase A that PTC + caching works (they should — both are orthogonal request-level features).

---

## 6. File-by-file change spec

### 6.1 New files

- `worker/src/ptc-types.ts` — TypeScript types for PTC events. ~80 lines.
- `worker/src/ptc-handler.ts` — Stream handler that dispatches inner tool calls back to the client. ~150 lines.
- `worker/src/__tests__/ptc-handler.test.ts` — Unit tests with mocked Anthropic responses. ~200 lines.
- `web/lib/ai/ptc-capability.ts` — `isPTCCapable(provider, model)` feature detection. ~30 lines. Imported by both worker and web.
- `web/lib/db/migrations/0066_add_used_ptc_column.sql` — Migration to add `ai_usage_logs.used_ptc`.

### 6.2 Modified files

- `worker/src/ai-client.ts` — add `ptcEnabled` option to `callAIWithTools()`, branch to PTC dispatcher when set. ~40 lines added.
- `worker/src/container-agent.ts` — add PTC branch in loop, swap system prompt and tool declarations when PTC enabled. ~60 lines added.
- `web/lib/ai/client.ts` — mirror the `ptcEnabled` option (for symmetry; Vercel mode may not use it, but the type contract stays consistent). ~20 lines added.
- `web/lib/ai/prompts.ts` — add `buildPTCSystemPromptAddition()`. ~40 lines.
- `web/lib/ai/models.ts` — export `isPTCCapable()` helper that checks model ID against a whitelist. ~20 lines.
- `web/lib/db/schema.ts` — add `usedPtc: boolean` to `aiUsageLogs` table. ~2 lines.
- `web/lib/ai/usage-logger.ts` — pass `usedPtc` through to the insert. ~5 lines.
- `web/lib/ai/lens.ts` — accept `usedPTC` param in `logAICall()`. ~3 lines.
- `CLAUDE.md` — document PTC as a new capability in the remediation fix generation strategies section. ~30 lines.

### 6.3 Do NOT modify

- `web/lib/ai/auto-merge-gates.ts`
- `web/lib/ai/remediate.ts` main pipeline (only reading the new flag is OK; no logic changes)
- Any gate implementation files (security-scan, substrate-replay, prediction, etc.)
- Cortex/EAP integrations
- Kamal deployment configs

---

## 7. Testing strategy

### 7.1 Unit tests

In `worker/src/__tests__/ptc-handler.test.ts`:
- Request shape: PTC enabled → beta header present, allowed_callers on tools, code_execution tool declared
- Request shape: PTC disabled → no beta header, no allowed_callers, no code_execution tool
- Event parsing: mocked stream with `code_execution` + 3 `code_execution_tool_result` → inner calls dispatched 3 times
- Error propagation: Python raises → Claude sees the error message, not a silent failure
- Safety: inner `run_command("sudo rm -rf /")` → blocked by `isCommandAllowed()`, error returned to Python

### 7.2 Integration test (real API)

A single test in `worker/src/__tests__/ptc-integration.test.ts`, gated behind `INTEGRATION_TEST_ENABLED=1` env var:
- Starts a real Docker container with a minimal Node.js repo
- Sends a synthetic alert ("fix the null check in src/login.ts")
- Runs the container agent with PTC on
- Asserts: `tsc --noEmit` passes, PR-ready files returned, `used_ptc=true` in logs

### 7.3 Eval harness (golden dataset)

- 50 real anonymized alerts from `golden-dataset v4` (commit `1b7c6a9`)
- Run pipeline twice per alert (PTC on, PTC off), same model, same prompts
- Grade outcome: did the generated fix pass `tsc + build + test` in a fresh container? (LLM-as-judge plus deterministic build check)
- Aggregate: avg turns, avg wall time, avg cost, success rate
- Output a markdown report: `eval-results/ptc-vs-standard-YYYY-MM-DD.md`

### 7.4 Parity test

Record one real production remediation's inputs. Replay it through both paths (PTC on vs off) in staging. Diff the resulting file changes. Expected: functional equivalence, though literal diffs may differ.

---

## 8. Acceptance criteria

Done means all of:

- [ ] Phase A prototype reproducibly runs against Anthropic API (scratch/ gone, findings committed to this doc as an appendix)
- [ ] PTC path dispatches correctly for `claude-sonnet-4-5-20250929` and `claude-sonnet-4-6` (if supported per Phase A findings)
- [ ] Non-Anthropic providers pass all existing tests without modification
- [ ] `used_ptc` column exists and is populated correctly
- [ ] Eval harness run shows ≥20% fewer turns on PTC path with ≤2% regression in success rate
- [ ] Real production remediation with PTC enabled completes successfully end-to-end
- [ ] `/admin/ops` dashboard shows PTC adoption and turn delta
- [ ] `CLAUDE.md` updated
- [ ] Feature flag `PTC_ENABLED_FOR_PROJECTS` (env var) documented in `web/.env.example`
- [ ] No new linting errors, no type errors (`npx tsc --noEmit` clean in both `web/` and `worker/`)
- [ ] PR description includes the eval report summary

---

## 9. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PTC API changes while still in beta | Medium | High | Pin the beta header version (`advanced-tool-use-2025-11-20`). Monitor Anthropic changelog weekly. Keep non-PTC path 100% functional. |
| Inner tool calls time out mid-Python | Medium | Medium | Each inner `run_command` already has 240s timeout. Document that Python total wall time can be up to `40 turns × 240s` worst case, but practical limit is Anthropic's sandbox timeout (verify in Phase A). |
| Haiku doesn't support PTC | High | Low | Verify in Phase A. If not supported, use PTC only in the final 3 fix turns (where Sonnet already takes over). |
| Security regression via Python smuggling unsafe commands | Low | Critical | All inner calls go through `executeContainerTool()` with the same whitelist. Add an adversarial test: Python that tries to `run_command("curl evil.com")` — must be blocked. |
| Token costs unexpectedly higher | Medium | Medium | Phase A measures this. If PTC costs >1.2× standard tokens despite fewer turns, flag for reconsideration. |
| Prompt caching breaks with PTC | Low | Medium | Explicit test in Phase A: cache + PTC together. If incompatible, ship PTC without caching first, address separately. |
| Model writes broken Python that infinite-loops | Low | Medium | Sandbox timeout is Anthropic's responsibility. Log wall time per PTC turn; if p95 grows past 120s, disable PTC by env var. |
| Degraded UX when users see PTC turns as "1 big step" instead of granular progress | Medium | Low | `updateProgress()` must emit synthetic events for each inner tool call so the dashboard UI stays live. |

---

## 10. Out of scope (do not do)

- Migrating Vercel mode (`web/lib/ai/container-agent.ts`) to PTC
- Implementing PTC for OpenAI GPT-5.x or any non-Anthropic provider
- Changing the 17 auto-merge gates
- Changing the `apply_patch` envelope format
- Changing the container image or Docker/gVisor layer (that's PR #8's domain)
- Building a self-hosted Python sandbox (Anthropic provides it)
- Multi-agent fanout patterns (separate work item, not bundled here)
- Updating the Rust CLI (`cli/`) — it doesn't use the container agent

---

## 11. Useful commands

```bash
# Verify you're on the right branch
git branch --show-current   # should print: feat/ptc-container-agent

# Read the files you'll modify (do this FIRST)
cat worker/src/container-agent.ts | head -200
cat worker/src/ai-client.ts | head -200
cat web/lib/ai/client.ts | head -200
cat web/lib/ai/models.ts

# Count tokens in the current system prompt to plan caching
wc -c worker/src/container-agent.ts | awk '{print $1/4 " approx tokens"}'

# Run existing tests to establish baseline
cd worker && npm test -- container-agent
cd web && npx vitest run lib/ai

# Type check
cd worker && npx tsc --noEmit
cd web && npx tsc --noEmit

# Run a local dev instance to dogfood
cd web && npm run dev

# After writing migration
cd web && npx drizzle-kit generate
# Review the SQL, then:
npx tsx scripts/run-migration-0066.ts   # (write this script following the 0064 pattern)
```

---

## 12. Deliverables checklist

When this task is complete, hand back to Jesus:

- [ ] Merged PR on branch `feat/ptc-container-agent` (do NOT push to `main` — Jesus decides when to ship)
- [ ] Eval report markdown file: `eval-results/ptc-vs-standard-YYYY-MM-DD.md`
- [ ] Updated `CLAUDE.md` diff
- [ ] `.env.example` diff showing `PTC_ENABLED_FOR_PROJECTS`
- [ ] Screenshots of `/admin/ops` showing the new PTC widget
- [ ] One paragraph summary: "What PTC bought us, what it didn't, recommended rollout"
- [ ] Appendix at the top of this doc with Phase A findings (update this doc in-place)

---

## 13. References

- Anthropic — Advanced Tool Use: https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic — Building Effective Agents: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic — Prompt Caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic — Tool Use: https://platform.claude.com/docs/en/build-with-claude/tool-use
- Anthropic SDK (TypeScript): https://github.com/anthropics/anthropic-sdk-typescript
- Anthropic Cookbook: https://github.com/anthropics/anthropic-cookbook
- InariWatch CLAUDE.md — project-level instructions, checked into the repo root

---

## 14. Communication

If you hit a blocker that requires a decision from Jesus:

1. Do NOT push partial work to `main`
2. Do NOT change the auto-merge gates or 17-gate logic without explicit approval
3. Write a message to Jesus via GitHub issue in `orbita-pos/inariwatch` titled `[PTC] Blocker: <short description>`
4. Keep the branch in a buildable state at all times (`tsc --noEmit` clean, tests passing)

Jesus's constraints to respect:
- No committing / pushing without his explicit permission
- Stay on Hetzner — do not introduce AWS, GCP, or Vercel-only dependencies
- Never mock the database in tests — use real test database or explicit in-memory stubs with parity
- Every change must be backward-compatible (there are real paying users as of 2026)
- Run `next build` in `web/` before proposing any push to verify build works

End of plan.
