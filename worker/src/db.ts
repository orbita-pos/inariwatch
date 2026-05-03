/**
 * Neon database connection for the worker.
 *
 * Contains schema subsets for all tables the worker needs to access.
 * This is intentionally a subset of web/lib/db/schema.ts — the worker
 * only touches tables relevant to its jobs.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { pgTable, uuid, text, jsonb, integer, boolean, timestamp, doublePrecision, numeric, index } from "drizzle-orm/pg-core";

// ── Remediation Sessions (container agent) ──────────────────────────────────

export const remediationSessions = pgTable("remediation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Fase 4 — userId is required by ai_usage_logs; the worker writes
  // prepush telemetry rows and needs to resolve userId from the session.
  userId: uuid("user_id"),
  // Phase 3.2 (Code Intel v2) — A/B telemetry needs alertId so it can
  // satisfy the NOT NULL FK on code_intel_remediation_ab.
  alertId: uuid("alert_id"),
  // Phase 3.2 — projectId is the lookup key for the per-workspace pct
  // override; existing pool path also uses it.
  projectId: uuid("project_id"),
  status: text("status").notNull().default("analyzing"),
  steps: jsonb("steps").notNull().default([]),
  error: text("error"),
  // Repo slug "owner/name" — needed by the What-If pipeline to clone.
  repo: text("repo"),
  branch: text("branch"),
  baseBranch: text("base_branch"),
  mergedCommitSha: text("merged_commit_sha"),
  fileChanges: jsonb("file_changes"),
  confidenceScore: integer("confidence_score"),
  checkpointPhase: text("checkpoint_phase"),
  checkpointData: jsonb("checkpoint_data"),
  // Fase 2b — 'pool-warm' when checkout succeeded, 'pool-cold-fallback'
  // when checkout missed and we cold-spawned. NULL when the pool is
  // disabled (CONTAINER_POOL_ENABLED=false) so the dashboard can
  // distinguish "pool off" from "pool miss".
  sandboxMode: text("sandbox_mode"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── AI Usage Logs (Fase 4 — prepush telemetry) ──────────────────────────────
//
// Worker-side subset of the web `ai_usage_logs` table. The worker only
// inserts pre-push hook rows (feature 'prepush-tsc|test|lint') — other
// writers live in web/lib/ai/lens.ts. Columns here track the NOT NULL
// fields of the migration plus a handful of nullable columns we set.
// Keep in sync with web/lib/db/schema.ts::aiUsageLogs.

export const aiUsageLogs = pgTable("ai_usage_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  projectId: uuid("project_id"),
  alertId: uuid("alert_id"),
  remediationSessionId: uuid("remediation_session_id"),
  feature: text("feature").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 8 }).notNull().default("0"),
  isPlatformKey: boolean("is_platform_key").notNull().default(false),
  error: text("error"),
  durationMs: integer("duration_ms"),
  toolName: text("tool_name"),
  toolExecMs: integer("tool_exec_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Sandbox Audit Log (Fase 5 — CodeAct) ────────────────────────────────────
//
// Worker-side subset of web `sandbox_audit_log` (migration 0069). One row
// per CodeAct sandbox invocation written by worker/src/sandbox/runner.ts.
// Code itself lives in ai_usage_logs.prompt; this table only stores the
// SHA-256 hash so identical invocations correlate without exposing source.
// Keep in sync with web/lib/db/schema.ts::sandboxAuditLog.

export const sandboxAuditLog = pgTable("sandbox_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id"),
  aiUsageLogId: uuid("ai_usage_log_id"),
  codeHash: text("code_hash").notNull(),
  purpose: text("purpose").notNull(),
  resultSizeBytes: integer("result_size_bytes").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  success: boolean("success").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Substrate Recordings (for What-If replay) ──────────────────────────────

export const substrateRecordings = pgTable("substrate_recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  recordingId: text("recording_id").notNull().unique(),
  alertId: uuid("alert_id"),
  projectId: uuid("project_id"),
  // VAR Q1 — correlation id from X-IW-Session-Id header. Allows the
  // worker to look up "give me the recording for this browser session".
  sessionId: text("session_id"),
  command: text("command"),
  runtime: text("runtime").default("node"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  eventCount: integer("event_count").default(0),
  events: jsonb("events"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── What-If Replay Cache (VAR Q1) ───────────────────────────────────────────
//
// Read-only from the worker's perspective — the web service writes
// these rows after the first compute. The fleet verification job
// consults this cache before spending a clone+substrate round per
// sibling, which makes the common "same fix verified across N
// sessions" case O(1) per session instead of O(minutes).

export const whatifReplays = pgTable("whatif_replays", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  fixId: uuid("fix_id"),
  result: jsonb("result").notNull(),
  status: text("status").notNull().default("ready"),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Fleet Verification (VAR Q2 — Gate 12) ───────────────────────────────────
//
// Worker-side schema subset. Only columns the worker reads/writes: id,
// alert+remediation fks, progress counters, session_results JSONB. Full
// schema lives in web/lib/db/schema.ts.

// ── Performance Benchmarks (VAR Q2 — Gate 17) ───────────────────────────────
//
// Worker-side schema subset. The performance-benchmark job reads substrate
// events from whatif_replays, computes p50/p99 latency regression, writes
// the result here. One row per (alert, remediation, sha).

export const performanceBenchmarks = pgTable("performance_benchmarks", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").notNull(),
  remediationId: uuid("remediation_id").notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  baselineP50Ms: doublePrecision("baseline_p50_ms"),
  baselineP99Ms: doublePrecision("baseline_p99_ms"),
  fixP50Ms: doublePrecision("fix_p50_ms"),
  fixP99Ms: doublePrecision("fix_p99_ms"),
  regressionPercent: doublePrecision("regression_percent"),
  affectedPaths: jsonb("affected_paths").notNull().default([]),
  thresholdPercent: doublePrecision("threshold_percent").notNull().default(10),
  passed: boolean("passed"),
  status: text("status").notNull().default("running"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const fleetVerificationRuns = pgTable("fleet_verification_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").notNull(),
  remediationId: uuid("remediation_id").notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  fingerprint: text("fingerprint").notNull(),
  bullmqJobId: text("bullmq_job_id"),
  status: text("status").notNull().default("running"),
  sessionsTotal: integer("sessions_total").notNull(),
  sessionsAttempted: integer("sessions_attempted").notNull().default(0),
  countMatched: integer("count_matched").notNull().default(0),
  countUncertain: integer("count_uncertain").notNull().default(0),
  countWouldNotPrevent: integer("count_would_not_prevent").notNull().default(0),
  countErrored: integer("count_errored").notNull().default(0),
  sessionResults: jsonb("session_results").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
});

// ── VAR Q2 Week 5: Gate 13 Behavioral Drift ─────────────────────────────────

export const sessionEndpointMetrics = pgTable("session_endpoint_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  substrateRecordingId: uuid("substrate_recording_id").notNull(),
  projectId: uuid("project_id").notNull(),
  endpointSignature: text("endpoint_signature").notNull(),
  endpointUrlRaw: text("endpoint_url_raw"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  healthy: boolean("healthy").notNull().default(true),
  latencyMs: doublePrecision("latency_ms"),
  dbQueryCount: integer("db_query_count").notNull().default(0),
  externalHttpCount: integer("external_http_count").notNull().default(0),
  topStatus: integer("top_status"),
  downstreamSignatures: jsonb("downstream_signatures").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const behavioralDriftRuns = pgTable("behavioral_drift_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").notNull(),
  remediationId: uuid("remediation_id").notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  bullmqJobId: text("bullmq_job_id"),
  windowDays: integer("window_days").notNull().default(7),
  status: text("status").notNull().default("running"),
  analyzedEndpoints: integer("analyzed_endpoints").notNull().default(0),
  insufficientDataEndpoints: integer("insufficient_data_endpoints").notNull().default(0),
  driftedEndpoints: integer("drifted_endpoints").notNull().default(0),
  improvedEndpoints: integer("improved_endpoints").notNull().default(0),
  maxDriftScore: doublePrecision("max_drift_score"),
  endpointDetails: jsonb("endpoint_details").notNull().default([]),
  improvementsDetected: jsonb("improvements_detected").notNull().default([]),
  thresholdDriftedPercent: doublePrecision("threshold_drifted_percent").notNull().default(20),
  passed: boolean("passed"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
});

// ── Uptime Monitoring ───────────────────────────────────────────────────────

export const uptimeMonitors = pgTable("uptime_monitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  url: text("url").notNull(),
  name: text("name"),
  intervalSec: integer("interval_sec").default(60).notNull(),
  expectedStatus: integer("expected_status").default(200).notNull(),
  timeoutMs: integer("timeout_ms").default(10000).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  isDown: boolean("is_down").default(false).notNull(),
  consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
  healTriggeredAt: timestamp("heal_triggered_at"),
  lastCheckedAt: timestamp("last_checked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const uptimeChecks = pgTable("uptime_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  monitorId: uuid("monitor_id").notNull(),
  statusCode: integer("status_code"),
  responseTimeMs: integer("response_time_ms"),
  isUp: boolean("is_up").notNull(),
  error: text("error"),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});

// ── Alerts ──────────────────────────────────────────────────────────────────

export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sourceIntegrations: text("source_integrations").array().notNull().default([]),
  isResolved: boolean("is_resolved").default(false).notNull(),
  isRead: boolean("is_read").default(false).notNull(),
  // VAR Q1/Q2 — correlation columns used by fleet verification and the
  // FullTrace aggregator. Kept nullable to match the web schema.
  sessionId: text("session_id"),
  fingerprint: text("fingerprint"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Replay Sessions (VAR Q1/Q2) ─────────────────────────────────────────────
//
// Worker-side subset. The fleet verification job queries this table to
// find all sessions that hit a given error fingerprint (via the
// error_fingerprints text[] column). `alerts` can't be the source
// because its partial UNIQUE(project_id, fingerprint) dedupes to one
// row per error — so fleet signal lives in replay_sessions instead.

export const replaySessions = pgTable("replay_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull().unique(),
  projectId: uuid("project_id"),
  errorFingerprints: text("error_fingerprints").array().notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
});

// ── Projects ────────────────────────────────────────────────────────────────

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  organizationId: uuid("organization_id"),
  autoMergeConfig: jsonb("auto_merge_config"),
});

// ── Notifications ───────────────────────────────────────────────────────────

export const notificationQueue = pgTable("notification_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  status: text("status").notNull().default("pending"),
  priority: integer("priority").default(1),
});

export const notificationChannels = pgTable("notification_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});

// ── Escalation ──────────────────────────────────────────────────────────────

export const escalationRules = pgTable("escalation_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  minSeverity: text("min_severity").notNull().default("critical"),
  delaySec: integer("delay_sec").notNull().default(1800),
  targetType: text("target_type").notNull().default("channel"),
  channelId: uuid("channel_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Notification Logs (for dedup) ───────────────────────────────────────────

export const notificationLogs = pgTable("notification_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  status: text("status").notNull(),
  sentAt: timestamp("sent_at").defaultNow(),
});

// ── Organizations ───────────────────────────────────────────────────────────

export const organizationMembers = pgTable("organization_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull().default("member"),
});

// Phase 3.2 — worker subset of `organizations`. Only the columns the A/B
// router needs: id (for the lookup) + the per-workspace pct override
// (migration 0082). The web-side schema is the SSOT.
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeIntelV2AgentAbPct: integer("code_intel_v2_agent_ab_pct"),
});

// Phase 3.2 — `projects` is already exported above (line ~289) with the
// columns the A/B router needs (id + organizationId). The Phase 3.2 work
// only reads those two columns; no extra subset is required here.

// ── Code Intel v2 A/B telemetry (Phase 3.2) ─────────────────────────────────
//
// One row per `runAgentJob`. Engine = which tool set the agent saw. The
// cutover dashboard (Phase 3.3) aggregates this table to decide GO/WAIT/
// ABORT on flipping CODE_INTEL_V2 default.
//
// Worker is a write-mostly consumer; only the cutover script + endpoint
// READ this table, both on the web side. Keep in sync with
// `web/lib/db/schema.ts::codeIntelRemediationAb`.

export const codeIntelRemediationAb = pgTable(
  "code_intel_remediation_ab",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id").notNull(),
    remediationSessionId: uuid("remediation_session_id"),
    /** 'v1' | 'v2' — enforced by CHECK constraint on the SQL side. */
    engine: text("engine").notNull(),
    /** Captured at decision time; NULL = global env was used. */
    workspacePct: integer("workspace_pct"),
    turnCount: integer("turn_count").notNull(),
    success: boolean("success").notNull(),
    /** Aggregate AI cost in USD. Worker writes NULL today. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    durationMs: integer("duration_ms").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_code_intel_remediation_ab_alert").on(table.alertId),
    index("idx_code_intel_remediation_ab_engine_created").on(table.engine, table.createdAt),
    index("idx_code_intel_remediation_ab_session").on(table.remediationSessionId),
  ],
);

// ── Deploy Monitors ─────────────────────────────────────────────────────────

export const deployMonitors = pgTable("deploy_monitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts").notNull(),
  installationId: uuid("installation_id").notNull(),
  deploySource: text("deploy_source").notNull(),
  deployId: text("deploy_id"),
  checkAt: timestamp("check_at").notNull(),
  status: text("status").default("pending").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Slack ────────────────────────────────────────────────────────────────────

export const slackInstallations = pgTable("slack_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: text("team_id").notNull(),
  botToken: text("bot_token").notNull(),
});

// ── Connection ──────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = neon(DATABASE_URL);
export const db = drizzle(sql);
