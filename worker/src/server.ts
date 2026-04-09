/**
 * InariWatch Worker Server — runs on Hetzner alongside the Go container server.
 * Accepts remediation jobs and runs the AI container agent loop locally.
 *
 * Endpoints:
 *   POST /worker/run     — start a new agent job
 *   GET  /worker/job/:id — check job status
 *   GET  /worker/health  — health check
 */

import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { runAgentJob, type AgentJobParams, type AgentJobResult } from "./container-agent.js";

const PORT = Number(process.env.WORKER_PORT ?? 9401);
const SECRET = process.env.STAGING_API_SECRET ?? "";
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);

// ── Job store ───────────────────────────────────────────────────────────────

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
  return auth === `Bearer ${SECRET}`;
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

// ── Routes ──────────────────────────────────────────────────────────────────

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Check capacity
  const running = [...jobs.values()].filter((j) => j.status === "running").length;
  if (running >= MAX_CONCURRENT) {
    json(res, 503, { error: `At capacity (${running}/${MAX_CONCURRENT} jobs running)` });
    return;
  }

  const body = JSON.parse(await readBody(req)) as AgentJobParams;
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
    job.error = err instanceof Error ? err.message : String(err);
    console.error(`[${jobId}] failed: ${job.error}`);
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

function handleHealth(res: ServerResponse, authenticated: boolean): void {
  if (!authenticated) {
    json(res, 200, { ok: true });
    return;
  }
  const running = [...jobs.values()].filter((j) => j.status === "running").length;
  json(res, 200, {
    ok: true,
    activeJobs: running,
    maxJobs: MAX_CONCURRENT,
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
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
    } else {
      json(res, 404, { error: "Not found" });
    }
  } catch (err) {
    console.error(`[server] error:`, err instanceof Error ? err.message : String(err));
    json(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`InariWatch Worker listening on port ${PORT}`);
  console.log(`Max concurrent jobs: ${MAX_CONCURRENT}`);
  console.log(`Go server: ${process.env.GO_SERVER_URL ?? "http://localhost:9400"}`);
});
