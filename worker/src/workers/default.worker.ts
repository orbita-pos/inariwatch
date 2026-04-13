/**
 * Default Worker — processes normal-priority jobs.
 *
 * Jobs:
 *   poll-integrations     — poll services without webhooks (week 4)
 *   flush-notifications   — process notification queue (week 3)
 *   deploy-monitor        — sweep pending deploy health checks
 *   escalate-alert        — delayed escalation for a single alert
 *   deploy-health-check   — delayed post-deploy check for a specific monitor
 */

import { Worker, type Job } from "bullmq";
import { connection } from "../queues.js";
import { escalateAlert } from "../jobs/escalate-alert.js";
import { checkDeployHealth, deployMonitorSweep } from "../jobs/deploy-monitor.js";
import { flushNotifications } from "../jobs/flush-notifications.js";
import { pollIntegrations } from "../jobs/poll-integrations.js";

async function handler(job: Job): Promise<unknown> {
  switch (job.name) {
    case "escalate-alert":
      return await escalateAlert(job.data.alertId);

    case "deploy-monitor":
      return await deployMonitorSweep();

    case "deploy-health-check":
      return await checkDeployHealth(job.data.monitorId);

    case "flush-notifications":
      return await flushNotifications();

    case "poll-integrations":
      return await pollIntegrations();

    default:
      console.warn(`[default] Unknown job: ${job.name}`);
  }
}

export function startDefaultWorker(): Worker {
  const worker = new Worker("default", handler, {
    connection,
    concurrency: 5,
    limiter: {
      max: 100,
      duration: 60_000,
    },
  });

  worker.on("failed", (job, err) => {
    console.error(`[default] ${job?.name} failed: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error("[default] Worker error:", err.message);
  });

  console.log("[default-worker] Started (concurrency: 5)");
  return worker;
}
