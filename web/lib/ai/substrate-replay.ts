/**
 * Substrate Replay Verification
 *
 * Uses the Substrate I/O recording (HTTP requests, DB queries, file ops captured
 * before the crash) to verify if a fix would prevent the error.
 *
 * Three modes:
 * 1. AI Analysis (v1) — the AI reads the recording + fix and predicts success (fast, no infra)
 * 2. GitHub Action Replay — pushes a workflow that replays requests against the fix
 * 3. RaaS / deterministic (v2) — Sesión 17 endpoint runs substrate-v2-replay
 *    in a gVisor sandbox on inari-staging. Behind SUBSTRATE_V2_GATE canary.
 */

import { db, substrateRecordings, substrateReplayComparisons } from "@/lib/db";
import { replaySessions } from "@/lib/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { callAI } from "./client";
import type { AIProvider } from "./client";
import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReplayResult {
  passed: boolean;
  confidence: number;       // 0-100
  riskScore: number;        // 0-100 (lower = safer)
  analysis: string;         // human-readable explanation
  replayedEvents: number;   // how many I/O events were analyzed
  mode: "ai_analysis" | "action_replay" | "raas_v2";
  /** Whether a frontend Replay V2 session (DOM + user journey) enriched the analysis. */
  replayContextUsed?: boolean;
  /** v2-only: runner sub-mode reported by the RaaS binary (drain | live | diff). */
  v2RunnerMode?: string;
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
  model: string,
  logContext?: {
    userId: string;
    remediationSessionId?: string;
    isPlatformKey?: boolean;
  },
  /**
   * Optional Replay V2 session id. If supplied, the frontend DOM user journey
   * + causal chain are pulled in and included in the AI prompt — this lets
   * the analyst reason about "user clicked X → HTTP Y → DB Z → error" rather
   * than only the raw backend I/O recording.
   */
  replaySessionId?: string,
): Promise<ReplayResult | null> {
  // Prefer a recording linked to this specific alert; fall back to the most
  // recent project recording only if none is directly associated.
  const selectCols = {
    events: substrateRecordings.events,
    context: substrateRecordings.context,
    eventCount: substrateRecordings.eventCount,
    categories: substrateRecordings.categories,
  };

  let [recording] = await db
    .select(selectCols)
    .from(substrateRecordings)
    .where(eq(substrateRecordings.alertId, alertId))
    .orderBy(desc(substrateRecordings.createdAt))
    .limit(1);

  if (!recording) {
    [recording] = await db
      .select(selectCols)
      .from(substrateRecordings)
      .where(eq(substrateRecordings.projectId, projectId))
      .orderBy(desc(substrateRecordings.createdAt))
      .limit(1);
  }

  if (!recording) return null;

  const events = recording.events as unknown[];
  if (!events || (Array.isArray(events) && events.length === 0)) return null;

  // Format the recording for AI analysis
  const recordingText = formatRecording(events, recording.categories as Record<string, unknown> | null);

  const fixSummary = fixFiles
    .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 2000)}`)
    .join("\n\n");

  // Pull in the frontend replay context if available — this gives the analyst
  // the user's exact journey (click → http → db → error) alongside raw I/O.
  let replayJourneySection = "";
  let replayContextUsed = false;
  if (replaySessionId) {
    // Scope the lookup to the current remediation's projectId — defense in
    // depth against future callers that might pass an arbitrary replay id
    // via remediation_sessions.context. Without this, a cross-tenant read
    // would only be blocked by the upstream endpoint.
    const journey = await loadReplayJourney(replaySessionId, projectId);
    if (journey) {
      replayJourneySection = `\n\n## FRONTEND USER JOURNEY (captured browser-side):\n${journey.slice(0, 3000)}`;
      replayContextUsed = true;
    }
  }

  const prompt = `Analyze this production I/O recording and determine if the proposed fix would prevent the crash.

## I/O RECORDING (what happened before the crash):
${recordingText.slice(0, 6000)}${replayJourneySection}

## DIAGNOSIS:
${diagnosis}

## PROPOSED FIX:
${fixSummary.slice(0, 4000)}

Analyze whether this fix addresses the root cause visible in the recording${replayContextUsed ? " AND the user journey above" : ""}.`;

  try {
    const raw = await callAI(apiKey, SYSTEM_REPLAY_ANALYST, [{ role: "user", content: prompt }], {
      maxTokens: 512,
      timeout: 30000,
      model,
      provider,
      ...(logContext ? {
        log: {
          userId: logContext.userId,
          projectId,
          alertId,
          remediationSessionId: logContext.remediationSessionId,
          feature: "remediation" as const,
          isPlatformKey: logContext.isPlatformKey,
        },
      } : {}),
    });

    const result = JSON.parse(raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());

    return {
      passed: result.wouldPreventCrash === true && (result.riskScore ?? 50) <= 40,
      confidence: result.confidence ?? 50,
      riskScore: result.riskScore ?? 50,
      analysis: result.reasoning ?? "No analysis provided",
      replayedEvents: recording.eventCount ?? 0,
      mode: "ai_analysis",
      replayContextUsed,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a compact, prompt-friendly version of the Replay V2 user journey —
 * AI summary + causal chain steps. Returns `null` if the session doesn't
 * exist, isn't enriched yet, or has no useful context.
 */
async function loadReplayJourney(replaySessionId: string, projectId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({
        aiSummary: replaySessions.aiSummary,
        aiChapters: replaySessions.aiChapters,
        urlsVisited: replaySessions.urlsVisited,
      })
      .from(replaySessions)
      .where(and(
        eq(replaySessions.sessionId, replaySessionId),
        eq(replaySessions.projectId, projectId),
      ))
      .limit(1);

    if (!row) return null;

    const lines: string[] = [];
    if (row.aiSummary) lines.push(row.aiSummary.slice(0, 400));

    // Phase 2 shape: { chapters, chains }
    const ai = row.aiChapters as unknown;
    if (ai && typeof ai === "object" && !Array.isArray(ai)) {
      const chains = (ai as { chains?: unknown[] }).chains;
      if (Array.isArray(chains) && chains.length > 0) {
        lines.push("\nCausal chain(s):");
        for (const c of chains.slice(0, 3)) {
          if (!c || typeof c !== "object") continue;
          const chain = c as { links?: { role?: string; summary?: string; tsRelative?: number }[] };
          if (!Array.isArray(chain.links)) continue;
          const steps = chain.links
            .filter((l): l is { role: string; summary: string; tsRelative: number } =>
              typeof l?.role === "string" && typeof l.summary === "string",
            )
            .map((l) => `  ${l.role} @ ${l.tsRelative ?? 0}ms: ${l.summary.slice(0, 160)}`)
            .join("\n");
          if (steps) lines.push(steps);
        }
      }
    }

    if (Array.isArray(row.urlsVisited) && row.urlsVisited.length > 0) {
      lines.push(`\nURLs visited: ${row.urlsVisited.slice(0, 5).join(", ")}`);
    }

    const out = lines.join("\n").trim();
    return out.length > 0 ? out : null;
  } catch {
    // Never block remediation on a replay lookup failure
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

// ── v2 (RaaS / deterministic) Mode — Sesión 17 ───────────────────────────────
//
// Sesión 17 exposed the Substrate v2 replay-engine as POST /v2/replay on the
// inari-staging Go orchestrator. It downloads a recording, optionally clones
// the fix branch, and runs `substrate-v2-replay` inside a gVisor sandbox.
// We call it through the existing STAGING_SERVER_URL + STAGING_API_SECRET
// pair (same env vars the Container Agent and Preview Fix use).
//
// The endpoint can return:
//   • 200 with a normal verdict (drain or live)
//   • 503 when REPLAY_V2_BINARY isn't deployed yet (graceful: pre-rsync state)
//   • 4xx on bad input (we treat as null → no v2 verdict)

const RAAS_DEFAULT_TIMEOUT_MS = 60_000;

/** v2-shaped response from the inari-staging /v2/replay endpoint. */
interface ReplayV2Response {
  id: string;
  runner_mode?: string;
  throw_reproduced?: boolean;
  fix_neutralized_throw?: boolean;
  divergence?: string | null;
  throws?: { message?: string; type?: string }[];
  events_drained?: number;
  exit_code?: number;
  duration_ms?: number;
  sandbox_runtime?: string;
}

export interface AnalyzeReplayV2Args {
  /** Project for the recording lookup. */
  projectId: string;
  /** Alert id — used both for the recording lookup and audit trail. */
  alertId: string;
  /** Optional fix branch the RaaS should check out before replaying. */
  fixBranch?: string;
  /** Repo URL passed to RaaS (only used when fixBranch is set). */
  repoUrl?: string;
  /** Optional GitHub token forwarded to RaaS for private repos. */
  githubToken?: string;
  /**
   * Override the recording_url passed to RaaS. Defaults to the substrate
   * recording fetched from the local DB via {@link buildRecordingDescriptor}.
   * Lets tests inject a fixture URL without hitting Postgres.
   */
  recordingUrlOverride?: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Override the staging URL/secret (for tests). */
  stagingUrlOverride?: string;
  stagingSecretOverride?: string;
  /** Optional command for live mode. Absent → drain-only. */
  command?: string;
  timeoutSeconds?: number;
}

/**
 * Call the Sesión 17 RaaS endpoint and convert the response to a ReplayResult.
 * Returns `null` when:
 *   • STAGING_SERVER_URL or STAGING_API_SECRET is unset (canary disabled)
 *   • there is no substrate recording for the alert/project
 *   • the endpoint replies 503 (binary not deployed) or any non-2xx
 *   • the network call throws / times out
 *
 * Never logs or persists on its own — caller decides what to do with null.
 */
export async function analyzeReplayV2(
  args: AnalyzeReplayV2Args,
): Promise<{ result: ReplayResult | null; runnerMode: string }> {
  const stagingUrl = (args.stagingUrlOverride ?? process.env.STAGING_SERVER_URL ?? "").replace(/\/+$/, "");
  const stagingSecret = args.stagingSecretOverride ?? process.env.STAGING_API_SECRET ?? "";
  if (!stagingUrl || !stagingSecret) {
    return { result: null, runnerMode: "unconfigured" };
  }

  // Resolve the recording URL the RaaS should fetch. By default we point it
  // back at our recordings download endpoint; tests inject a fixture URL.
  let recordingUrl = args.recordingUrlOverride ?? null;
  if (!recordingUrl) {
    const desc = await buildRecordingDescriptor(args.projectId, args.alertId);
    if (!desc) return { result: null, runnerMode: "no_recording" };
    recordingUrl = desc.url;
  }

  const body: Record<string, unknown> = {
    recording_url: recordingUrl,
    timeout_seconds: args.timeoutSeconds ?? 60,
  };
  if (args.fixBranch && args.repoUrl) {
    body.repo_url = args.repoUrl;
    body.fix_branch = args.fixBranch;
    if (args.githubToken) body.github_token = args.githubToken;
  }
  if (args.command) body.command = args.command;

  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RAAS_DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${stagingUrl}/v2/replay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${stagingSecret}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 503) {
      // REPLAY_V2_BINARY unset on the orchestrator — Sesión 17 deploy still pending.
      return { result: null, runnerMode: "unavailable" };
    }
    if (!res.ok) {
      return { result: null, runnerMode: `error_${res.status}` };
    }

    const data = (await res.json()) as ReplayV2Response;
    const runner = data.runner_mode ?? "unknown";

    // Verdict mapping:
    //   throw_reproduced=false → fix likely prevented the recorded failure (pass)
    //   throw_reproduced=true  → fix did NOT prevent the throw (fail)
    //   missing → drain-only run with no Node execution; treat as "no signal"
    const reproduced = data.throw_reproduced;
    if (typeof reproduced !== "boolean") {
      // Drain-only (no command) gives us replay coverage but no fix verdict —
      // surface it as null so the gate logs runner_mode without producing a
      // false pass/fail signal.
      return { result: null, runnerMode: runner };
    }

    const passed = reproduced === false;
    // Risk + confidence are deterministic for v2 — there's no model
    // uncertainty. Map to the same 0-100 scale v1 uses so downstream gate
    // thresholds keep working unchanged.
    const riskScore = passed ? 10 : 90;
    const confidence = passed ? 95 : 95;
    const reasonParts: string[] = [];
    if (passed) {
      reasonParts.push("v2 deterministic replay drained without reproducing the throw.");
    } else {
      const sample = data.throws?.[0];
      reasonParts.push("v2 deterministic replay reproduced the original throw against the fix branch.");
      if (sample?.message) reasonParts.push(`First throw: ${sample.message.slice(0, 200)}`);
    }
    if (data.divergence) reasonParts.push(`Divergence: ${data.divergence.slice(0, 160)}`);

    return {
      result: {
        passed,
        confidence,
        riskScore,
        analysis: reasonParts.join(" "),
        replayedEvents: data.events_drained ?? 0,
        mode: "raas_v2",
        v2RunnerMode: runner,
      },
      runnerMode: runner,
    };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error";
    return { result: null, runnerMode: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Look up the most-recent recording for an alert and build a fetch URL. */
async function buildRecordingDescriptor(
  projectId: string,
  alertId: string,
): Promise<{ recordingId: string; url: string } | null> {
  const [recording] = await db
    .select({ recordingId: substrateRecordings.recordingId })
    .from(substrateRecordings)
    .where(eq(substrateRecordings.alertId, alertId))
    .orderBy(desc(substrateRecordings.createdAt))
    .limit(1);

  let recordingId = recording?.recordingId ?? null;
  if (!recordingId) {
    const [fallback] = await db
      .select({ recordingId: substrateRecordings.recordingId })
      .from(substrateRecordings)
      .where(eq(substrateRecordings.projectId, projectId))
      .orderBy(desc(substrateRecordings.createdAt))
      .limit(1);
    recordingId = fallback?.recordingId ?? null;
  }
  if (!recordingId) return null;

  // Surface the recording over our own API. The RaaS validates that the URL
  // is HTTPS (or loopback) and forwards the optional auth_header verbatim;
  // for now the canary points at an internal route that may not yet stream
  // the v2 binary format — when it doesn't, RaaS returns no verdict and
  // we record runner_mode='no_recording'/'error_*' in the comparison row.
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!base) return null;
  return {
    recordingId,
    url: `${base}/api/recordings/${encodeURIComponent(recordingId)}/binary`,
  };
}

// ── Canary router ────────────────────────────────────────────────────────────
//
// SUBSTRATE_V2_GATE=true  → enable the v2 canary. Within that, only ~5% of
//                           alerts (deterministic by hash of alertId) actually
//                           route to v2 as primary. The other 95% stay on v1.
// SUBSTRATE_V2_GATE unset  → the gate is byte-identical to project_var_in_loop_replay.md.
//
// 5% bucketing uses the first 4 hex chars of SHA-256(alertId) so the same
// alert always falls into the same bucket — important when the loop retries
// and we want consistent gate behaviour across turns.

const SUBSTRATE_V2_CANARY_PERCENT = 5;

export function isSubstrateV2GateEnabled(): boolean {
  return process.env.SUBSTRATE_V2_GATE === "true";
}

export function inSubstrateV2Canary(alertId: string, percent = SUBSTRATE_V2_CANARY_PERCENT): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const h = crypto.createHash("sha256").update(alertId).digest();
  // 16-bit bucket: 0..65535. percent% of that range → < (65536 * percent / 100).
  const bucket = h.readUInt16BE(0);
  return bucket < Math.floor(65536 * percent / 100);
}

export interface RunReplayGateArgs {
  projectId: string;
  alertId: string;
  diagnosis: string;
  fixFiles: { path: string; content: string }[];
  apiKey: string;
  provider: AIProvider;
  model: string;
  log?: {
    userId: string;
    remediationSessionId?: string;
    isPlatformKey?: boolean;
  };
  replaySessionId?: string;
  /** v2 inputs (forwarded to analyzeReplayV2 when canary picks v2). */
  fixBranch?: string;
  repoUrl?: string;
  githubToken?: string;
  /** Optional dependency injection for tests. */
  v1Impl?: typeof analyzeReplay;
  v2Impl?: typeof analyzeReplayV2;
  /** When set, force the canary decision (skip the percentage hash). */
  forceCanary?: boolean;
}

export interface RunReplayGateResult {
  /** Verdict the loop should act on, or null when neither v1 nor v2 produced one. */
  verdict: ReplayResult | null;
  /** Which gate the verdict came from. */
  source: "v1" | "v2" | null;
  /** Whether the canary fired this call (i.e. v2 was attempted). */
  canaryFired: boolean;
  /** Comparison row id when both gates ran, else null. */
  comparisonId: string | null;
  /** v2 runner sub-mode for telemetry — even when no verdict was returned. */
  v2RunnerMode: string | null;
}

/**
 * Single entrypoint the agentic loop calls for the substrate-replay gate.
 *
 * Flag off → behaves exactly like calling analyzeReplay() directly.
 * Flag on + canary bucket → runs v2 (primary) + v1 (shadow) in parallel,
 *                           persists a comparison row, returns v2's verdict
 *                           when v2 produced one, otherwise falls back to v1.
 * Flag on + non-canary bucket → v1 only, no comparison row.
 */
export async function runReplayGate(args: RunReplayGateArgs): Promise<RunReplayGateResult> {
  const v1Impl = args.v1Impl ?? analyzeReplay;
  const v2Impl = args.v2Impl ?? analyzeReplayV2;
  const enabled = isSubstrateV2GateEnabled();
  const canaryFired = enabled && (args.forceCanary ?? inSubstrateV2Canary(args.alertId));

  // Fast path — flag off OR not in canary. Identical to calling v1 directly.
  if (!canaryFired) {
    const verdict = await v1Impl(
      args.projectId,
      args.alertId,
      args.diagnosis,
      args.fixFiles,
      args.apiKey,
      args.provider,
      args.model,
      args.log,
      args.replaySessionId,
    );
    return {
      verdict,
      source: verdict ? "v1" : null,
      canaryFired: false,
      comparisonId: null,
      v2RunnerMode: null,
    };
  }

  // Canary fired — run both, primary = v2.
  const v1Start = Date.now();
  const v2Start = Date.now();
  const [v1Settled, v2Settled] = await Promise.allSettled([
    v1Impl(
      args.projectId,
      args.alertId,
      args.diagnosis,
      args.fixFiles,
      args.apiKey,
      args.provider,
      args.model,
      args.log,
      args.replaySessionId,
    ),
    v2Impl({
      projectId: args.projectId,
      alertId: args.alertId,
      fixBranch: args.fixBranch,
      repoUrl: args.repoUrl,
      githubToken: args.githubToken,
    }),
  ]);
  const v1Duration = Date.now() - v1Start;
  const v2Duration = Date.now() - v2Start;

  const v1Verdict: ReplayResult | null = v1Settled.status === "fulfilled" ? v1Settled.value : null;
  const v2Bundle = v2Settled.status === "fulfilled"
    ? v2Settled.value
    : { result: null as ReplayResult | null, runnerMode: "error" };
  const v2Verdict = v2Bundle.result;
  const v2RunnerMode = v2Bundle.runnerMode;

  // Pick the source. v2 wins when it produced a verdict; otherwise fall back
  // to v1 so the loop always has the strongest available signal.
  const source: "v1" | "v2" | null = v2Verdict ? "v2" : v1Verdict ? "v1" : null;
  const verdict = v2Verdict ?? v1Verdict ?? null;

  const comparisonId = await persistComparison({
    alertId: args.alertId,
    remediationSessionId: args.log?.remediationSessionId,
    recordingId: await getRecordingIdForAlert(args.projectId, args.alertId),
    v1: v1Verdict ? { ...v1Verdict, durationMs: v1Duration } : null,
    v2: v2Verdict ? { ...v2Verdict, durationMs: v2Duration } : null,
    v2RunnerMode,
    chosen: source === "v2" ? "v2" : "v1",
  });

  return {
    verdict,
    source,
    canaryFired: true,
    comparisonId,
    v2RunnerMode,
  };
}

interface PersistComparisonArgs {
  alertId: string;
  remediationSessionId?: string;
  recordingId: string | null;
  v1: (ReplayResult & { durationMs: number }) | null;
  v2: (ReplayResult & { durationMs: number }) | null;
  v2RunnerMode: string;
  chosen: "v2" | "v1";
}

async function persistComparison(args: PersistComparisonArgs): Promise<string | null> {
  const agreed = args.v1 && args.v2 ? args.v1.passed === args.v2.passed : null;
  try {
    const [row] = await db
      .insert(substrateReplayComparisons)
      .values({
        alertId: args.alertId,
        remediationSessionId: args.remediationSessionId,
        recordingId: args.recordingId,
        v1Passed: args.v1?.passed ?? null,
        v1RiskScore: args.v1?.riskScore ?? null,
        v1Confidence: args.v1?.confidence ?? null,
        v1Reason: args.v1?.analysis.slice(0, 1000) ?? null,
        v1DurationMs: args.v1?.durationMs ?? null,
        v2Passed: args.v2?.passed ?? null,
        v2RiskScore: args.v2?.riskScore ?? null,
        v2Confidence: args.v2?.confidence ?? null,
        v2Reason: args.v2?.analysis.slice(0, 1000) ?? null,
        v2DurationMs: args.v2?.durationMs ?? null,
        v2RunnerMode: args.v2RunnerMode,
        chosen: args.chosen,
        agreed,
      })
      .returning({ id: substrateReplayComparisons.id });
    return row?.id ?? null;
  } catch (err) {
    // Comparison logging never blocks the gate.
    console.warn(
      "[substrate-replay] comparison insert failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function getRecordingIdForAlert(projectId: string, alertId: string): Promise<string | null> {
  try {
    const desc = await buildRecordingDescriptor(projectId, alertId);
    return desc?.recordingId ?? null;
  } catch {
    return null;
  }
}
