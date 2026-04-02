/**
 * Substrate Replay Verification
 *
 * Uses the Substrate I/O recording (HTTP requests, DB queries, file ops captured
 * before the crash) to verify if a fix would prevent the error.
 *
 * Two modes:
 * 1. AI Analysis — the AI reads the recording + fix and predicts success (fast, no infra)
 * 2. GitHub Action Replay — pushes a workflow that replays requests against the fix (real verification)
 */

import { db, substrateRecordings } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { callAI } from "./client";
import type { AIProvider } from "./client";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReplayResult {
  passed: boolean;
  confidence: number;       // 0-100
  riskScore: number;        // 0-100 (lower = safer)
  analysis: string;         // human-readable explanation
  replayedEvents: number;   // how many I/O events were analyzed
  mode: "ai_analysis" | "action_replay";
}

// ── AI Analysis Mode (fast, always available) ────────────────────────────────

const SYSTEM_REPLAY_ANALYST = `You are an expert production incident analyst. You analyze I/O recordings from before a crash to determine if a proposed code fix would prevent the error.

You receive:
1. A recording of HTTP requests, DB queries, and file operations that happened before the crash
2. The diagnosis of what went wrong
3. The code fix that was generated

Your job: determine if this fix would prevent the same sequence of operations from crashing.

Respond ONLY in valid JSON:
{
  "wouldPreventCrash": true | false,
  "confidence": <number 0-100>,
  "riskScore": <number 0-100>,
  "reasoning": "2-3 sentences explaining your analysis",
  "risks": ["list of remaining risks, if any"]
}

Risk score guide:
  0-20: Very safe — the fix clearly addresses the recorded failure
  21-40: Safe — the fix likely prevents the crash but has minor unknowns
  41-60: Moderate — the fix addresses part of the issue, some paths still risky
  61-80: Risky — the fix might not prevent the crash, significant unknowns
  81-100: Dangerous — the fix doesn't address the recorded failure pattern`;

export async function analyzeReplay(
  projectId: string,
  alertId: string,
  diagnosis: string,
  fixFiles: { path: string; content: string }[],
  apiKey: string,
  provider: AIProvider,
  model: string
): Promise<ReplayResult | null> {
  // Fetch the most recent Substrate recording for this project
  const [recording] = await db
    .select({
      events: substrateRecordings.events,
      context: substrateRecordings.context,
      eventCount: substrateRecordings.eventCount,
      categories: substrateRecordings.categories,
    })
    .from(substrateRecordings)
    .where(eq(substrateRecordings.projectId, projectId))
    .orderBy(desc(substrateRecordings.createdAt))
    .limit(1);

  if (!recording) return null;

  const events = recording.events as unknown[];
  if (!events || (Array.isArray(events) && events.length === 0)) return null;

  // Format the recording for AI analysis
  const recordingText = formatRecording(events, recording.categories as Record<string, unknown> | null);

  const fixSummary = fixFiles
    .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 2000)}`)
    .join("\n\n");

  const prompt = `Analyze this production I/O recording and determine if the proposed fix would prevent the crash.

## I/O RECORDING (what happened before the crash):
${recordingText.slice(0, 6000)}

## DIAGNOSIS:
${diagnosis}

## PROPOSED FIX:
${fixSummary.slice(0, 4000)}

Analyze whether this fix addresses the root cause visible in the recording.`;

  try {
    const raw = await callAI(apiKey, SYSTEM_REPLAY_ANALYST, [{ role: "user", content: prompt }], {
      maxTokens: 512,
      timeout: 30000,
      model,
      provider,
    });

    const result = JSON.parse(raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());

    return {
      passed: result.wouldPreventCrash === true && (result.riskScore ?? 50) <= 40,
      confidence: result.confidence ?? 50,
      riskScore: result.riskScore ?? 50,
      analysis: result.reasoning ?? "No analysis provided",
      replayedEvents: recording.eventCount ?? 0,
      mode: "ai_analysis",
    };
  } catch {
    return null;
  }
}

// ── GitHub Action Replay Mode (real verification) ────────────────────────────

/**
 * Generate a GitHub Actions workflow file that replays Substrate I/O events
 * against the application running with the fix applied.
 *
 * The workflow:
 * 1. Checks out the fix branch
 * 2. Installs dependencies and builds
 * 3. Starts the app in test mode
 * 4. Replays the recorded HTTP requests
 * 5. Checks for crashes/errors in the output
 * 6. Reports pass/fail as a check run
 */
export function generateReplayWorkflow(
  recording: { events: unknown[]; context: unknown },
  appStartCommand: string = "npm start",
  appPort: number = 3000
): { path: string; content: string } {
  // Extract HTTP requests from the recording for replay
  const events = recording.events as Record<string, unknown>[];
  const httpEvents = events
    .filter((e) => e.type === "http_request" || e.type === "http")
    .slice(0, 20); // Cap at 20 requests for the replay

  const SAFE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

  const curlCommands = httpEvents
    .map((e) => {
      // Validate HTTP method — reject anything that isn't a standard method
      const rawMethod = String(e.method ?? "GET").toUpperCase();
      if (!SAFE_METHODS.has(rawMethod)) return null;

      // Sanitize URL path — only allow safe characters, reject shell metacharacters
      const rawUrl = String(e.url ?? e.path ?? "/");
      const safePath = rawUrl.replace(/[^a-zA-Z0-9_\-./:%?&=@+,;]/g, "");
      if (!safePath.startsWith("/")) return null;

      // Body — use env var to avoid shell injection entirely
      const hasBody = e.body != null;
      const bodyFlag = hasBody ? '-d "$REQ_BODY"' : "";
      const contentType = hasBody ? '-H "Content-Type: application/json"' : "";
      const envPrefix = hasBody
        ? `REQ_BODY=${shellQuote(JSON.stringify(e.body))} `
        : "";

      return `${envPrefix}curl -sf -X ${rawMethod} ${contentType} ${bodyFlag} "http://localhost:${appPort}${safePath}" || REPLAY_FAILED=1`;
    })
    .filter((cmd): cmd is string => cmd !== null);

  if (curlCommands.length === 0) {
    // No HTTP events to replay — generate a simple health check
    curlCommands.push(`curl -sf "http://localhost:${appPort}/" || REPLAY_FAILED=1`);
  }

  const workflowContent = `# Auto-generated by InariWatch — Substrate I/O Replay
# Replays the recorded HTTP requests that led to the production crash
# against the fixed application to verify the fix prevents the error.

name: Substrate Replay Verification

on:
  push:
    branches: ['radar/fix-*']

jobs:
  substrate-replay:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build --if-present
        env:
          NODE_ENV: test

      - name: Start application
        run: |
          ${appStartCommand} &
          APP_PID=$!
          echo "APP_PID=$APP_PID" >> $GITHUB_ENV

          # Wait for app to be ready
          for i in $(seq 1 30); do
            if curl -sf http://localhost:${appPort}/ > /dev/null 2>&1; then
              echo "App is ready"
              break
            fi
            sleep 2
          done

      - name: Replay Substrate I/O events
        run: |
          REPLAY_FAILED=0
          echo "Replaying ${curlCommands.length} recorded HTTP requests..."

${curlCommands.map((cmd) => `          ${cmd}`).join("\n")}

          if [ "$REPLAY_FAILED" = "1" ]; then
            echo "::error::Substrate replay detected failures — the fix may not prevent the original crash"
            exit 1
          fi
          echo "All ${curlCommands.length} replayed requests succeeded"

      - name: Stop application
        if: always()
        run: |
          if [ -n "$APP_PID" ]; then
            kill $APP_PID 2>/dev/null || true
          fi
`;

  return {
    path: ".github/workflows/inariwatch-substrate-replay.yml",
    content: workflowContent,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRecording(
  events: unknown[],
  categories: Record<string, unknown> | null
): string {
  const lines: string[] = [];

  if (categories) {
    const cats = Object.entries(categories)
      .filter(([, v]) => v && typeof v === "number" && v > 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (cats) lines.push(`Event categories: ${cats}`);
  }

  const arr = events as Record<string, unknown>[];
  for (const event of arr.slice(0, 50)) {
    const type = event.type ?? "unknown";
    const ts = event.timestamp ?? "";

    if (type === "http_request" || type === "http") {
      lines.push(`[${ts}] HTTP ${event.method ?? "?"} ${event.url ?? event.path ?? "?"} → ${event.statusCode ?? "?"}`);
      if (event.error) lines.push(`  Error: ${String(event.error).slice(0, 200)}`);
    } else if (type === "db_query" || type === "database") {
      lines.push(`[${ts}] DB: ${String(event.query ?? event.operation ?? "?").slice(0, 200)}`);
      if (event.error) lines.push(`  Error: ${String(event.error).slice(0, 200)}`);
    } else if (type === "file") {
      lines.push(`[${ts}] File ${event.operation ?? "?"}: ${event.path ?? "?"}`);
    } else if (type === "error" || type === "exception") {
      lines.push(`[${ts}] ERROR: ${String(event.message ?? event.error ?? "?").slice(0, 300)}`);
      if (event.stack) lines.push(`  Stack: ${String(event.stack).slice(0, 300)}`);
    } else {
      lines.push(`[${ts}] ${type}: ${JSON.stringify(event).slice(0, 200)}`);
    }
  }

  return lines.join("\n");
}

/** Escape a string for safe use as a shell single-quoted value. */
function shellQuote(s: string): string {
  // Wrap in single quotes, escape embedded single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
