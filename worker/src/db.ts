/**
 * Neon database connection for the worker.
 *
 * Contains schema subsets for all tables the worker needs to access.
 * This is intentionally a subset of web/lib/db/schema.ts — the worker
 * only touches tables relevant to its jobs.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { pgTable, uuid, text, jsonb, integer, boolean, timestamp } from "drizzle-orm/pg-core";

// ── Remediation Sessions (container agent) ──────────────────────────────────

export const remediationSessions = pgTable("remediation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("analyzing"),
  steps: jsonb("steps").notNull().default([]),
  error: text("error"),
  fileChanges: jsonb("file_changes"),
  confidenceScore: integer("confidence_score"),
  checkpointPhase: text("checkpoint_phase"),
  checkpointData: jsonb("checkpoint_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
