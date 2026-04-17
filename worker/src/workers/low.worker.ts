/**
 * Low Worker — processes background, non-urgent jobs.
 *
 * Jobs:
 *   anomaly-aggregate     — pre-aggregate hourly alert counts + spike detection
 *   digest                — trigger digest email processing
 *   escalation-sweep      — fallback sweep for missed escalations
 *   poll-webhook-fallback — weekly fallback poll for GitHub/Vercel/Sentry
 *   fleet-verification    — VAR Gate 12 — batched What-If across top N sessions
 */

import { Worker, type Job } from "bullmq";
import { connection } from "../queues.js";
import { escalationSweep } from "../jobs/escalate-alert.js";
import { runAnomalyAggregation } from "../jobs/anomaly-aggregate.js";
import { runDigest } from "../jobs/digest.js";
import { pollWebhookFallback } from "../jobs/poll-integrations.js";
import { runFleetVerification, type FleetJobInput } from "../jobs/fleet-verification.js";
import { runPerformanceBenchmark, type PerfJobInput } from "../jobs/performance-benchmark.js";
import { runSubstrateExtract, type SubstrateExtractInput } from "../jobs/substrate-extract.js";
import { runBehavioralDrift, type DriftJobInput } from "../jobs/behavioral-drift.js";

async function handler(job: Job): Promise<unknown> {
  switch (job.name) {
    case "escalation-sweep":
      return await escalationSweep();

    case "anomaly-aggregate":
      return await runAnomalyAggregation();

    case "digest":
      return await runDigest();

    case "poll-webhook-fallback":
      return await pollWebhookFallback();

    case "fleet-verification":
      return await runFleetVerification(job.data as FleetJobInput);

    case "performance-benchmark":
      return await runPerformanceBenchmark(job.data as PerfJobInput);

    case "substrate-extract":
      return await runSubstrateExtract(job.data as SubstrateExtractInput);

    case "behavioral-drift":
      return await runBehavioralDrift(job.data as DriftJobInput);

    default:
      console.warn(`[low] Unknown job: ${job.name}`);
  }
}

export function startLowWorker(): Worker {
  const worker = new Worker("low", handler, {
    connection,
    concurrency: 3,
    limiter: {
      max: 30,
      duration: 60_000,
    },
  });

  worker.on("failed", (job, err) => {
    console.error(`[low] ${job?.name} failed: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error("[low] Worker error:", err.message);
  });

  console.log("[low-worker] Started (concurrency: 3)");
  return worker;
}
