/**
 * InariWatch Worker Server — runs on Hetzner alongside the Go container server.
 *
 * Two responsibilities:
 *   1. Container agent — runs AI remediation jobs in Docker containers
 *   2. Job queue — BullMQ workers process background jobs (uptime, polling, notifications)
 *
 * Endpoints:
 *   POST /worker/run       — start a new agent job
 *   GET  /worker/job/:id   — check agent job status
 *   POST /worker/enqueue   — add a job to the queue (called by Vercel)
 *   GET  /worker/jobs       — bull-board dashboard (HTML)
 *   GET  /worker/health    — health check
 */

import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { runAgentJob, type AgentJobParams, type AgentJobResult } from "./container-agent.js";
import { runWhatIf } from "./whatif/handler.js";
import { getQueue, allQueues } from "./queues.js";
import { startScheduler } from "./scheduler.js";
import { startCriticalWorker } from "./workers/critical.worker.js";
import { startDefaultWorker } from "./workers/default.worker.js";
import { startLowWorker } from "./workers/low.worker.js";
import type { Worker } from "bullmq";

const PORT = Number(process.env.WORKER_PORT ?? 9401);
const SECRET = process.env.STAGING_API_SECRET ?? "";
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);

// ── Secret scrubbing for logs ──────────────────────────────────────────────
//
// Defense in depth against GitHub / internal token leakage via log lines.
// /worker/whatif receives `githubToken` in its body; if any code path
// throws an Error whose `.message` happens to include the raw body JSON
// (e.g. a future debug log added by a careless patch), console.error
// would write the token to systemd journal. The scrubber runs on every
// message at log time and replaces common token shapes with `***`.
//
// Patterns covered:
//   - GitHub fine-grained PATs (github_pat_...)
//   - GitHub classic PATs + OAuth tokens (gh[pousr]_...)
//   - Bearer headers followed by any opaque token
//   - x-access-token:<token>@ pattern from clone URLs
const SECRET_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+\-/]{20,}/g,
  /x-access-token:[^@\s]+@/g,
];

function scrubSecrets(message: string): string {
  let out = message;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "***");
  // Also scrub the bearer secret explicitly when it's the ONE the worker
  // knows about — covers custom secret shapes that don't match the
  // generic regex (e.g. hex UUID style STAGING_API_SECRET values).
  if (SECRET.length >= 16) {
    out = out.split(SECRET).join("***");
  }
  return out;
}

function logError(prefix: string, err: unknown): void {
  const raw = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`${prefix} ${scrubSecrets(raw)}`);
}

// ── Job store (agent jobs) ─────────────────────────────────────────────────

interface Job {
  id: string;
  status: "running" | "completed" | "failed";
  result?: AgentJobResult;
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, Job>();

// Cleanup completed jobs after 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.startedAt < cutoff) jobs.delete(id);
  }
}, 60_000);

// ── Auth ────────────────────────────────────────────────────────────────────

function checkAuth(req: IncomingMessage): boolean {
  if (!SECRET) return false;
  const auth = req.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

// ── Routes: Agent ──────────────────────────────────────────────────────────

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Check capacity
  const running = [...jobs.values()].filter((j) => j.status === "running").length;
  if (running >= MAX_CONCURRENT) {
    json(res, 503, { error: `At capacity (${running}/${MAX_CONCURRENT} jobs running)` });
    return;
  }

  let body: AgentJobParams;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }
  if (!body.sessionId || !body.repoUrl || !body.aiKey) {
    json(res, 400, { error: "Missing required fields: sessionId, repoUrl, aiKey" });
    return;
  }

  const jobId = body.sessionId;
  const job: Job = { id: jobId, status: "running", startedAt: Date.now() };
  jobs.set(jobId, job);

  // Run in background — respond immediately
  runAgentJob(body).then((result) => {
    job.status = "completed";
    job.result = result;
    console.log(`[${jobId}] completed in ${result.turns} turns (verified: ${result.verified})`);
  }).catch((err) => {
    job.status = "failed";
    // Preserve the raw message on the job record (admin dashboard shows
    // this to an authed operator who needs the detail). Logs get the
    // scrubbed version — the journal is a lower-trust surface.
    job.error = err instanceof Error ? err.message : String(err);
    logError(`[${jobId}] failed:`, err);
  });

  json(res, 202, { jobId, status: "running" });
}

function handleJobStatus(res: ServerResponse, jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) {
    json(res, 404, { error: "Job not found" });
    return;
  }

  const response: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    elapsed: Date.now() - job.startedAt,
  };
  if (job.result) response.result = job.result;
  if (job.error) response.error = job.error;

  json(res, 200, response);
}

// ── Routes: Queue ──────────────────────────────────────────────────────────

const ALLOWED_JOBS: Record<string, string[]> = {
  critical: ["uptime-check", "post-alert-created", "process-webhook"],
  default: ["escalate-alert", "deploy-monitor", "deploy-health-check", "flush-notifications", "poll-integrations"],
  low: ["escalation-sweep", "anomaly-aggregate", "digest", "poll-webhook-fallback", "fleet-verification", "performance-benchmark", "substrate-extract", "behavioral-drift", "slo-check"],
};

async function handleEnqueue(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: {
    queue?: string;
    name: string;
    data?: Record<string, unknown>;
    opts?: { delay?: number; priority?: number; attempts?: number };
  };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (!body.name) {
    json(res, 400, { error: "Missing required field: name" });
    return;
  }

  const queueName = body.queue ?? "default";
  const allowed = ALLOWED_JOBS[queueName] ?? ALLOWED_JOBS.default;
  if (!allowed.includes(body.name)) {
    json(res, 400, { error: `Job "${body.name}" not allowed on queue "${queueName}"` });
    return;
  }

  const queue = getQueue(queueName);
  const job = await queue.add(body.name, body.data ?? {}, {
    delay: body.opts?.delay,
    priority: body.opts?.priority,
    attempts: body.opts?.attempts,
  });

  json(res, 201, { ok: true, jobId: job.id, queue: queue.name });
}

// ── Routes: What-If Replay ─────────────────────────────────────────────────

/**
 * POST /worker/whatif
 *
 * Runs a deterministic Substrate replay against a merged remediation.
 * The web app calls this when WORKER_URL is set — the worker clones the
 * repo, applies fileChanges, auto-detects the entry point, and runs
 * substrate simulate on localhost (avoids the 15s Vercel timeout).
 *
 * Body: { sessionId, remediationId, githubToken? }
 * Auth: Bearer STAGING_API_SECRET (checked above in the server handler).
 *
 * Concurrency cap: each run does a shallow clone + substrate simulate
 * (~90s wall time) and writes to disk. Without a cap a client with the
 * bearer could saturate the Hetzner CX22's 2 vCPU + 4GB RAM by firing
 * N requests in parallel. We reject with 503 past the cap — the web
 * caller already has graceful degradation (falls back to AI).
 */
let activeWhatIfJobs = 0;
const MAX_WHATIF_CONCURRENT = Number(process.env.MAX_WHATIF_CONCURRENT ?? 2);

async function handleWhatIf(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (activeWhatIfJobs >= MAX_WHATIF_CONCURRENT) {
    json(res, 503, {
      error: `What-If worker at capacity (${activeWhatIfJobs}/${MAX_WHATIF_CONCURRENT}). Retry shortly.`,
      code: "capacity",
    });
    return;
  }

  let body: { sessionId?: string; remediationId?: string; githubToken?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }
  if (!body.sessionId || !body.remediationId) {
    json(res, 400, { error: "Missing required fields: sessionId, remediationId" });
    return;
  }

  activeWhatIfJobs++;
  try {
    const outcome = await runWhatIf({
      sessionId: body.sessionId,
      remediationId: body.remediationId,
      githubToken: body.githubToken,
    });

    if (outcome.ok) {
      json(res, 200, outcome.result);
    } else {
      json(res, outcome.status, outcome.error);
    }
  } finally {
    activeWhatIfJobs--;
  }
}

async function handleQueueStats(res: ServerResponse): Promise<void> {
  const stats = await Promise.all(
    allQueues.map(async (q) => {
      const counts = await q.getJobCounts();
      return { name: q.name, ...counts };
    })
  );
  json(res, 200, { queues: stats });
}

// ── Routes: Screenshot ─────────────────────────────────────────────────────

/**
 * POST /worker/screenshot
 *
 * Renders the given URL via Playwright (Chromium) and returns the PNG as
 * the response body with `Content-Type: image/png`. Used by Preview Fix
 * Tier 1 to capture a hero image once the ephemeral deploy reaches
 * `running`. The web app uploads the returned bytes to Vercel Blob and
 * stores the Blob URL on preview_sessions.
 *
 * Body: { url, width?, height?, fullPage?, timeoutMs? }
 * Returns: raw PNG bytes (image/png), or JSON error.
 *
 * Concurrency cap mirrors whatif's — Chromium is the single biggest RAM
 * consumer on the CX22 box (~400MB per warm browser + per-context
 * overhead). Unlimited parallel requests would OOM the worker.
 */
let activeScreenshotJobs = 0;
const MAX_SCREENSHOT_CONCURRENT = Number(process.env.MAX_SCREENSHOT_CONCURRENT ?? 3);

async function handleScreenshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (activeScreenshotJobs >= MAX_SCREENSHOT_CONCURRENT) {
    json(res, 503, {
      error: `Screenshot worker at capacity (${activeScreenshotJobs}/${MAX_SCREENSHOT_CONCURRENT}). Retry shortly.`,
    });
    return;
  }

  let body: { url?: string; width?: number; height?: number; fullPage?: boolean; timeoutMs?: number };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    json(res, 400, { error: "Missing required field: url" });
    return;
  }
  // Reject anything that isn't http(s) — we don't want the headless
  // Chromium chasing file://, data:, javascript:, or internal hostnames.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    json(res, 400, { error: "Invalid URL" });
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    json(res, 400, { error: "Only http(s) URLs allowed" });
    return;
  }

  activeScreenshotJobs += 1;
  try {
    const { takeScreenshot } = await import("./screenshot.js");
    const result = await takeScreenshot({
      url,
      width: typeof body.width === "number" ? body.width : undefined,
      height: typeof body.height === "number" ? body.height : undefined,
      fullPage: body.fullPage,
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    });
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": String(result.png.length),
      "X-Screenshot-Width": String(result.width),
      "X-Screenshot-Height": String(result.height),
    });
    res.end(result.png);
  } catch (err) {
    logError("[screenshot] failed:", err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    activeScreenshotJobs -= 1;
  }
}

// ── Routes: Health ─────────────────────────────────────────────────────────

let workers: Worker[] = [];
let isShuttingDown = false;

async function handleHealth(res: ServerResponse, authenticated: boolean): Promise<void> {
  if (!authenticated) {
    json(res, 200, { ok: !isShuttingDown });
    return;
  }

  const agentJobs = [...jobs.values()].filter((j) => j.status === "running").length;

  // Queue depths
  const queueStats = await Promise.all(
    allQueues.map(async (q) => {
      try {
        const counts = await q.getJobCounts();
        return { name: q.name, ...counts };
      } catch {
        return { name: q.name, error: "redis unavailable" };
      }
    })
  );

  // Worker states
  const workerStates = workers.map((w) => ({
    name: w.name,
    running: w.isRunning(),
    paused: w.isPaused(),
  }));

  json(res, isShuttingDown ? 503 : 200, {
    ok: !isShuttingDown,
    agentJobs,
    maxAgentJobs: MAX_CONCURRENT,
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    queues: queueStats,
    workers: workerStates,
  });
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check — basic ok for unauthenticated, detailed for authenticated
  if (req.method === "GET" && path === "/worker/health") {
    handleHealth(res, checkAuth(req));
    return;
  }

  // Auth for all other endpoints
  if (!checkAuth(req)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "POST" && path === "/worker/run") {
      await handleRun(req, res);
    } else if (req.method === "GET" && path.startsWith("/worker/job/")) {
      const jobId = path.split("/worker/job/")[1];
      handleJobStatus(res, jobId);
    } else if (req.method === "POST" && path === "/worker/enqueue") {
      await handleEnqueue(req, res);
    } else if (req.method === "POST" && path === "/worker/whatif") {
      await handleWhatIf(req, res);
    } else if (req.method === "POST" && path === "/worker/screenshot") {
      await handleScreenshot(req, res);
    } else if (req.method === "GET" && path === "/worker/queues") {
      await handleQueueStats(res);
    } else {
      json(res, 404, { error: "Not found" });
    }
  } catch (err) {
    logError("[server] error:", err);
    json(res, 500, { error: "Internal server error" });
  }
});

// ── Startup ─────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Start BullMQ workers
  workers = [
    startCriticalWorker(),
    startDefaultWorker(),
    startLowWorker(),
  ];

  // Register repeatable jobs
  await startScheduler();

  // Start HTTP server
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`InariWatch Worker listening on port ${PORT}`);
    console.log(`Max concurrent agent jobs: ${MAX_CONCURRENT}`);
    console.log(`Redis: ${process.env.REDIS_HOST ?? "127.0.0.1"}:${process.env.REDIS_PORT ?? 6379}`);
  });
}

// ── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — draining workers...`);

  // Stop accepting new HTTP requests
  server.close();

  // Close workers (wait for active jobs to finish, 10s timeout)
  const closePromises = workers.map((w) =>
    w.close().catch((err) => console.error(`[shutdown] Worker ${w.name} close error:`, err))
  );

  // Close queues
  const queueClosePromises = allQueues.map((q) =>
    q.close().catch((err) => console.error(`[shutdown] Queue ${q.name} close error:`, err))
  );

  await Promise.race([
    Promise.all([...closePromises, ...queueClosePromises]),
    new Promise((resolve) => setTimeout(resolve, 10000)), // 10s hard timeout
  ]);

  console.log("[shutdown] Clean shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});
