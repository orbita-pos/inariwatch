/**
 * Claude Managed Agent integration for InariWatch remediation.
 *
 * Runs the AI fix generation in an Anthropic-managed container with
 * full access to git, npm, tsc, and the project's build tools.
 * The agent clones the repo, diagnoses the error, generates a fix,
 * verifies it compiles (tsc + build + tests), then pushes to GitHub.
 *
 * Falls back to the agentic loop (tool_use) if Managed Agent fails.
 */

/**
 * Direct REST API client for Claude Managed Agents (beta).
 * Uses fetch() instead of the SDK because the current @anthropic-ai/sdk (0.78.0)
 * doesn't have managed agents types yet. This avoids upgrading the SDK.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ManagedAgentParams {
  /** Anthropic API key (PLATFORM_ANTHROPIC_KEY or user BYOK) */
  apiKey: string;
  /** Error title from the alert */
  errorTitle: string;
  /** Stack trace / error body */
  stackTrace: string;
  /** Severity: critical, warning, info */
  severity: string;
  /** Primary file from diagnosis (if available) */
  errorFile?: string;
  /** GitHub repo URL (https://github.com/owner/repo) */
  repositoryUrl: string;
  /** Branch to fix against (usually 'main') */
  branch: string;
  /** GitHub token with write permissions */
  githubToken: string;
  /** InariWatch project ID */
  projectId: string;
  /** Alert ID for branch naming */
  alertId: string;
  /** Additional context (Sentry, Vercel, codebase patterns) */
  additionalContext?: string;
  /** SSE event emitter */
  emit: (event: string, data: Record<string, unknown>) => void;
}

export interface ManagedAgentResult {
  status: "success" | "timeout" | "retriable_error" | "permanent_error";
  /** Fix explanation (for PR description) */
  explanation?: string;
  /** Files changed (path + content) */
  files?: { path: string; content: string }[];
  /** Branch name the fix was pushed to */
  branch?: string;
  /** Commit SHA */
  commitSha?: string;
  /** PR URL if created */
  prUrl?: string;
  /** PR number if created */
  prNumber?: number;
  /** Reason for failure (if not success) */
  reason?: string;
  /** Whether the agent ran tsc/tests/build successfully */
  verified?: boolean;
  /** Number of agent turns */
  turns?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const AGENT_NAME = "InariWatch Remediation Agent";
const ENV_NAME = "inariwatch-remediation-env";

/** How long before we give up and fall back (milliseconds) */
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ── Agent + Environment management ──────────────────────────────────────────

const API_BASE = "https://api.anthropic.com/v1";
const BETA_HEADER = "managed-agents-2026-04-01";

let cachedAgentId: string | null = null;
let cachedEnvId: string | null = null;

/** Make an authenticated request to the Managed Agents API. */
async function agentFetch(apiKey: string, path: string, opts?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETA_HEADER,
      "content-type": "application/json",
      ...opts?.headers,
    },
    signal: opts?.signal ?? AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Sanitize: strip any echoed auth headers or keys from error body
    const sanitized = text.slice(0, 300).replace(/(?:authorization|x-api-key|bearer\s+)\S+/gi, "[REDACTED]");
    throw new Error(`Managed Agent API error (${res.status}): ${sanitized}`);
  }

  return res.json();
}

async function ensureAgent(apiKey: string): Promise<string> {
  if (cachedAgentId) return cachedAgentId;

  // Check if agent already exists
  const existing = await agentFetch(apiKey, "/agents");
  const agents = (existing.data ?? []) as { id: string; name: string }[];
  const found = agents.find((a) => a.name === AGENT_NAME);
  if (found) {
    cachedAgentId = found.id;
    return found.id;
  }

  // Create new agent
  const agent = await agentFetch(apiKey, "/agents", {
    method: "POST",
    body: JSON.stringify({
      name: AGENT_NAME,
      model: "claude-sonnet-4-6",
      system: buildAgentInstructions(),
      tools: [
        {
          type: "agent_toolset_20260401",
          configs: [
            { name: "web_search", enabled: false },
            { name: "web_fetch", enabled: false },
          ],
        },
      ],
    }),
  });

  cachedAgentId = agent.id as string;
  return agent.id as string;
}

async function ensureEnvironment(apiKey: string): Promise<string> {
  if (cachedEnvId) return cachedEnvId;

  // Check if environment already exists
  const existing = await agentFetch(apiKey, "/environments");
  const envs = (existing.data ?? []) as { id: string; name: string }[];
  const found = envs.find((e) => e.name === ENV_NAME);
  if (found) {
    cachedEnvId = found.id;
    return found.id;
  }

  // Create new environment
  const env = await agentFetch(apiKey, "/environments", {
    method: "POST",
    body: JSON.stringify({
      name: ENV_NAME,
      config: {
        type: "cloud",
        packages: {
          npm: ["typescript"],
          apt: ["jq"],
        },
        networking: {
          type: "limited",
          allowed_hosts: ["api.github.com", "github.com", "registry.npmjs.org"],
          allow_package_managers: true,
        },
      },
    }),
  });

  cachedEnvId = env.id as string;
  return env.id as string;
}

// ── Agent Instructions ──────────────────────────────────────────────────────

function buildAgentInstructions(): string {
  return `You are an expert software engineer fixing production bugs in isolated containers.

You will receive an error with stack trace. The repository is already cloned at /workspace/repo.

WORKFLOW:
1. cd /workspace/repo
2. Read package.json to understand the stack (framework, ORM, dependencies)
3. Read the error file from the stack trace
4. Check imports — use ONLY libraries the project already uses
5. If a correct version of the same logic exists in the file (e.g., in another branch of if/else), copy that pattern
6. Generate the MINIMUM fix necessary
7. Verify: npx tsc --noEmit (MUST pass)
8. Verify: npm test (non-blocking if no tests)
9. Verify: npm run build (MUST pass for Next.js/compiled projects)
10. Create branch, commit, push

CRITICAL RULES:
- Use the project's ORM (Drizzle → ilike/eq, Prisma → client methods). NEVER use raw SQL.
- Do NOT modify .env, lock files, migrations, CI workflows
- Do NOT add new dependencies
- Make MINIMAL changes — don't refactor unrelated code
- If tsc fails, fix the TypeScript error and re-run
- If build fails, read the error and fix it

BRANCH NAMING: radar/fix-{ALERT_ID_PREFIX}-{TIMESTAMP}
COMMIT MESSAGE: fix: {ERROR_TITLE_SHORT}

When done, output a summary of what you changed and why.`;
}

// ── Main Function ───────────────────────────────────────────────────────────

export async function runManagedRemediation(params: ManagedAgentParams): Promise<ManagedAgentResult> {
  const {
    apiKey, errorTitle, stackTrace, severity, errorFile,
    repositoryUrl, branch, githubToken, alertId,
    additionalContext, emit,
  } = params;

  try {
    // Ensure agent and environment exist (cached after first call)
    emit("managed_agent", { status: "initializing" });
    const [agentId, envId] = await Promise.all([
      ensureAgent(apiKey),
      ensureEnvironment(apiKey),
    ]);

    // Create session with GitHub repo mounted
    emit("managed_agent", { status: "creating_session" });
    const branchTimestamp = Date.now().toString(36);
    const fixBranch = `radar/fix-${alertId.slice(0, 8)}-${branchTimestamp}`;

    const session = await agentFetch(apiKey, "/sessions", {
      method: "POST",
      body: JSON.stringify({
        agent: agentId,
        environment_id: envId,
        title: `Fix: ${errorTitle.slice(0, 100)}`,
        metadata: { alert_id: alertId, severity },
        resources: [
          {
            type: "github_repository",
            url: repositoryUrl,
            authorization_token: githubToken,
            mount_path: "/workspace/repo",
            checkout: { type: "branch", name: branch },
          },
        ],
      }),
    });

    const sessionId = session.id as string;

    // Send the error context as the first message
    emit("managed_agent", { status: "starting", sessionId });

    const userMessage = buildErrorMessage(errorTitle, stackTrace, severity, errorFile, fixBranch, additionalContext);

    // Open SSE stream FIRST, then send message
    const streamRes = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": BETA_HEADER,
      },
    });

    if (!streamRes.ok || !streamRes.body) {
      throw new Error(`Failed to open session stream: ${streamRes.status}`);
    }

    await agentFetch(apiKey, `/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: userMessage }],
          },
        ],
      }),
    });

    // Process streaming events with timeout
    const result = await processSessionStream(streamRes.body, sessionId, emit, SESSION_TIMEOUT_MS, fixBranch, apiKey, repositoryUrl, githubToken);

    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Classify error
    if (msg.includes("rate_limit") || msg.includes("overloaded") || msg.includes("timeout")) {
      return { status: "retriable_error", reason: msg };
    }
    if (msg.includes("401") || msg.includes("403") || msg.includes("not found")) {
      return { status: "permanent_error", reason: msg };
    }
    return { status: "retriable_error", reason: msg };
  }
}

// ── Error Message Builder ───────────────────────────────────────────────────

function buildErrorMessage(
  title: string,
  stackTrace: string,
  severity: string,
  errorFile: string | undefined,
  fixBranch: string,
  additionalContext: string | undefined,
): string {
  const parts = [
    `FIX THIS PRODUCTION ERROR:`,
    ``,
    `Title: ${title}`,
    `Severity: ${severity}`,
    errorFile ? `Primary file: ${errorFile}` : "",
    `Fix branch name: ${fixBranch}`,
    ``,
    `STACK TRACE:`,
    stackTrace.slice(0, 4000),
  ];

  if (additionalContext) {
    parts.push("", "ADDITIONAL CONTEXT:", additionalContext.slice(0, 4000));
  }

  parts.push(
    "",
    "INSTRUCTIONS:",
    "1. cd /workspace/repo && npm install",
    "2. Read the error file and understand the bug",
    "3. Fix it using the project's existing libraries (check imports)",
    "4. Run: npx tsc --noEmit (must pass)",
    "5. Run: npm run build (must pass if applicable)",
    `6. git checkout -b ${fixBranch}`,
    "7. git add the changed files (ONLY the files you modified)",
    `8. git commit -m "fix: ${title.slice(0, 60)}"`,
    `9. git push -u origin ${fixBranch}`,
    "",
    "When done, tell me: what you changed, why, and which files.",
  );

  return parts.filter(Boolean).join("\n");
}

// ── Stream Processor ────────────────────────────────────────────────────────

async function processSessionStream(
  body: ReadableStream<Uint8Array>,
  sessionId: string,
  emit: (event: string, data: Record<string, unknown>) => void,
  timeoutMs: number,
  fixBranch: string,
  apiKey: string,
  repositoryUrl: string,
  githubToken: string,
): Promise<ManagedAgentResult> {
  const startTime = Date.now();
  let lastText = "";
  let turns = 0;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        reader.cancel();
        return { status: "timeout", reason: `Session exceeded ${timeoutMs / 1000}s timeout`, turns };
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        const eventType = event.type as string;

        switch (eventType) {
          case "agent.message": {
            const content = event.content as { type: string; text?: string }[];
            if (content) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  lastText = block.text;
                  emit("managed_agent", { status: "message", text: block.text.slice(0, 200) });
                }
              }
            }
            break;
          }

          case "agent.tool_use": {
            turns++;
            const toolName = event.name as string;
            emit("managed_agent", { status: "tool_use", tool: toolName, turn: turns });
            break;
          }

          case "session.status_idle": {
            const stopReason = (event.stop_reason as { type: string })?.type;
            if (stopReason === "end_turn") {
              reader.cancel();
              emit("managed_agent", { status: "completed", turns });
              return parseAndVerifyAgentResult(lastText, fixBranch, turns, apiKey, repositoryUrl, githubToken);
            }
            break;
          }

          case "session.error": {
            const error = event.error as { message?: string } | undefined;
            const retryStatus = event.retry_status as string | undefined;
            if (retryStatus === "terminal") {
              reader.cancel();
              return { status: "permanent_error", reason: error?.message ?? "Session terminated", turns };
            }
            emit("managed_agent", { status: "retrying", error: error?.message });
            break;
          }

          case "session.status_terminated": {
            reader.cancel();
            return { status: "permanent_error", reason: "Session terminated unexpectedly", turns };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { status: "timeout", reason: "Stream ended without completion", turns };
}

// ── Result Parser ───────────────────────────────────────────────────────────

async function parseAndVerifyAgentResult(
  lastText: string,
  fixBranch: string,
  turns: number,
  apiKey: string,
  repositoryUrl: string,
  githubToken: string,
): Promise<ManagedAgentResult> {
  if (!lastText) {
    return { status: "retriable_error", reason: "Agent produced no output", turns };
  }

  // Check if the agent mentioned pushing successfully
  const pushSuccess = lastText.includes("push") && (
    lastText.includes("success") ||
    lastText.includes("pushed") ||
    lastText.includes("committed") ||
    lastText.includes(fixBranch)
  );

  if (pushSuccess) {
    // VERIFY: actually check that the branch exists on GitHub
    try {
      const [, owner, repo] = repositoryUrl.match(/github\.com\/([^/]+)\/([^/.]+)/) ?? [];
      if (owner && repo) {
        const { getBranchSha } = await import("@/lib/services/github-api");
        await getBranchSha(githubToken, owner, repo, fixBranch);
        // Branch exists — confirmed push
      }
    } catch {
      // Branch doesn't exist — agent lied or push failed silently
      return { status: "retriable_error", reason: "Agent reported push success but branch not found on GitHub", turns };
    }

    return {
      status: "success",
      explanation: lastText.slice(0, 500),
      branch: fixBranch,
      verified: true,
      turns,
    };
  }

  // Agent explicitly mentioned failure
  if (lastText.includes("error") || lastText.includes("failed") || lastText.includes("could not")) {
    return {
      status: "retriable_error",
      reason: lastText.slice(0, 500),
      turns,
    };
  }

  // Ambiguous — verify before trusting
  try {
    const [, owner, repo] = repositoryUrl.match(/github\.com\/([^/]+)\/([^/.]+)/) ?? [];
    if (owner && repo) {
      const { getBranchSha } = await import("@/lib/services/github-api");
      await getBranchSha(githubToken, owner, repo, fixBranch);
      return {
        status: "success",
        explanation: lastText.slice(0, 500),
        branch: fixBranch,
        verified: false,
        turns,
      };
    }
  } catch {
    // Branch doesn't exist
  }

  return { status: "retriable_error", reason: "Agent output ambiguous and branch not found", turns };
}
