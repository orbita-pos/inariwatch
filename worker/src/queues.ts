/**
 * BullMQ Queue Definitions
 *
 * Three priority-based queues:
 *   critical — uptime checks, incoming webhooks, alert processing
 *   default  — integration polling, notifications, escalation
 *   low      — digest emails, anomaly aggregation, cleanup
 *
 * All queues connect to Redis on localhost (Hetzner Docker container).
 */

import { Queue, type ConnectionOptions } from "bullmq";

export const connection: ConnectionOptions = {
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.REDIS_PORT ?? 6379),
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
};

export const criticalQueue = new Queue("critical", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

export const defaultQueue = new Queue("default", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 300 },
    removeOnFail: { count: 500 },
  },
});

export const lowQueue = new Queue("low", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

/** Get a queue by name. Defaults to "default". */
export function getQueue(name: string): Queue {
  switch (name) {
    case "critical": return criticalQueue;
    case "low": return lowQueue;
    default: return defaultQueue;
  }
}

export const allQueues = [criticalQueue, defaultQueue, lowQueue];
