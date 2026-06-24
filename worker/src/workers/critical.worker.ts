/**
 * Critical Worker — processes high-priority jobs.
 *
 * Jobs:
 *   uptime-check      — HTTP check on monitored URLs (direct, no Vercel)
 *   process-alert      — incoming alert from webhook (week 3)
 *   process-webhook    — raw webhook payload processing (week 3)
 */

import { Worker, type Job } from "bullmq";
import { connection } from "../queues.js";
import { runUptimeChecks } from "../jobs/uptime-check.js";
import { postAlertCreated } from "../jobs/post-alert-created.js";

async function handler(job: Job): Promise<unknown> {
  switch (job.name) {
    case "uptime-check":
      return await runUptimeChecks();

    case "post-alert-created":
      return await postAlertCreated(job.data);

    case "process-webhook":
      // TODO: Raw webhook processing (dedup + insert moved here)
      console.log(`[critical] process-webhook — ${job.data.source ?? "unknown"}`);
      return;

    default:
      console.warn(`[critical] Unknown job: ${job.name}`);
  }
}

export function startCriticalWorker(): Worker {
  const worker = new Worker("critical", handler, {
    connection,
    concurrency: 10,
    limiter: {
      max: 200,
      duration: 60_000,
    },
  });

  worker.on("failed", (job, err) => {
    console.error(`[critical] ${job?.name} failed: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error("[critical] Worker error:", err.message);
  });

  console.log("[critical-worker] Started (concurrency: 10)");
  return worker;
}
