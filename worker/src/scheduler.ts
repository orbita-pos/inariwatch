/**
 * Job Scheduler — registers repeatable jobs on startup.
 *
 * Replaces the Go cron scheduler for all background work.
 * Each job runs at a fixed interval with built-in dedup
 * (BullMQ guarantees only one instance per repeat key).
 */

import { criticalQueue, defaultQueue, lowQueue } from "./queues.js";

export async function startScheduler(): Promise<void> {
  // ── Critical (low latency, high priority) ──────────────────────────────

  // Uptime checks — HTTP check on monitored URLs, only write to DB on state change
  await criticalQueue.add("uptime-check", {}, {
    repeat: { every: 60_000 },
    priority: 1,
  });

  // ── Default (normal priority) ──────────────────────────────────────────

  // Poll integrations without webhooks (npm, postgres, expo)
  // GitHub/Vercel/Sentry skipped when webhook is active
  await defaultQueue.add("poll-integrations", {}, {
    repeat: { every: 120_000 },
    priority: 3,
  });

  // Flush notification queue
  await defaultQueue.add("flush-notifications", {}, {
    repeat: { every: 30_000 },
    priority: 2,
  });

  // Deploy health monitor — checks recent deploys for errors
  await defaultQueue.add("deploy-monitor", {}, {
    repeat: { every: 120_000 },
    priority: 4,
  });

  // ── Low (background, can wait) ─────────────────────────────────────────

  // Anomaly detection — pre-aggregate hourly counts, detect spikes
  await lowQueue.add("anomaly-aggregate", {}, {
    repeat: { every: 3_600_000 }, // 1 hour
    priority: 5,
  });

  // Digest emails
  await lowQueue.add("digest", {}, {
    repeat: { every: 3_600_000 }, // 1 hour
    priority: 5,
  });

  // Escalation sweep — catch any alerts missed by event-driven escalation
  await lowQueue.add("escalation-sweep", {}, {
    repeat: { every: 300_000 }, // 5 min (fallback only)
    priority: 4,
  });

  // SLO check — Fase 12 Part A. Measures per-tier SLOs over the last
  // 15 minutes of remediation_sessions and upserts breaches into
  // slo_events. 5-min cadence matches the arch spec's "3 consecutive
  // 5-min windows" paging rule.
  await lowQueue.add("slo-check", {}, {
    repeat: { every: 300_000 }, // 5 min
    priority: 5,
  });

  // Weekly fallback poll for webhook services (GitHub/Vercel/Sentry)
  // Catches events missed by webhooks — runs Sunday at 03:00 UTC
  await lowQueue.add("poll-webhook-fallback", {}, {
    repeat: { every: 7 * 24 * 3_600_000 }, // weekly
    priority: 6,
  });

  console.log("[scheduler] Repeatable jobs registered");
}
