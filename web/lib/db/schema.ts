import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Custom types ─────────────────────────────────────────────────────────────

const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown) {
    const str = value as string;
    return str
      .slice(1, -1)
      .split(",")
      .map(Number);
  },
});

const tsvector = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "tsvector";
  },
});

// ── Enums ─────────────────────────────────────────────────────────────────────

export const planEnum = pgEnum("plan", ["free", "pro"]);
export const severityEnum = pgEnum("severity", ["critical", "warning", "info"]);
export const notifTypeEnum = pgEnum("notification_type", ["telegram", "whatsapp", "email", "slack", "push"]);
export const integrationEnum = pgEnum("integration", ["github", "vercel", "sentry", "postgres", "git", "npm", "datadog", "uptime", "expo"]);

// ── Users ─────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  plan: planEnum("plan").default("free").notNull(),
  emailVerifiedAt: timestamp("email_verified_at"),
  totpSecret: text("totp_secret"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  aiModels: jsonb("ai_models"),

  activeOrgId: uuid("active_org_id"), // FK to organizations.id (enforced at DB level via migration 0011)

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// NextAuth accounts (OAuth providers)
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  type: text("type").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
});

// ── Organizations (workspaces) ────────────────────────────────────────────────

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: uuid("owner_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const organizationMembers = pgTable("organization_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: orgRoleEnum("role").default("member").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});

export const organizationInvites = pgTable("organization_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  email: text("email").notNull(),
  role: orgRoleEnum("role").default("member").notNull(),
  invitedBy: uuid("invited_by").references(() => users.id).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

// ── Projects ──────────────────────────────────────────────────────────────────

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  visibility: text("visibility").default("all").notNull(), // 'all' | 'restricted'
  autoMergeConfig: jsonb("auto_merge_config"), // AutoMergeConfig
  stagingEnvEncrypted: jsonb("staging_env_encrypted"), // Encrypted env vars for staging deploys
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AutoMergeConfig = {
  enabled: boolean;
  minConfidence: number;      // 0-100
  maxLinesChanged: number;
  requireSelfReview: boolean;
  postMergeMonitor: boolean;
  autoRevert: boolean;
  /** Autonomous mode: auto-trigger remediation on critical alerts (no human click needed) */
  autoRemediate: boolean;
  /** Auto-heal: rollback + remediate when uptime detects site is down */
  autoHeal: boolean;
  /** Prediction confidence threshold — block deploy if prediction confidence >= this (default: 80) */
  predictionThreshold: number;
  /** Set by the system when approval rate qualifies for autonomous mode. Shown as a suggestion banner. */
  suggestAutonomous?: boolean;
  /** ISO timestamp of last auto-confidence tune */
  confidenceTunedAt?: string;
  /** Previous minConfidence value before the last auto-tune */
  confidenceTunedFrom?: number;
};

export const DEFAULT_AUTO_MERGE_CONFIG: AutoMergeConfig = {
  enabled: false,
  minConfidence: 90,
  maxLinesChanged: 50,
  requireSelfReview: true,
  postMergeMonitor: true,
  autoRevert: true,
  autoRemediate: false,
  autoHeal: false,
  predictionThreshold: 80,
};

export const projectIntegrations = pgTable("project_integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  service: text("service").notNull(),
  // Encrypted JSON with tokens, repos, etc.
  configEncrypted: jsonb("config_encrypted"),
  webhookSecret: text("webhook_secret"),
  isActive: boolean("is_active").default(true).notNull(),
  lastCheckedAt: timestamp("last_checked_at"),
  lastSuccessAt: timestamp("last_success_at"),
  errorCount: integer("error_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Project Access Control ──────────────────────────────────────────────────
// Used when project.visibility = 'restricted'

export const memberRoleEnum = pgEnum("member_role", ["admin", "viewer"]);

export const projectMembers = pgTable("project_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: memberRoleEnum("role").default("viewer").notNull(),
  // Legacy columns kept to avoid migration
  invitedBy: uuid("invited_by").references(() => users.id),
  invitedAt: timestamp("invited_at").defaultNow(),
  acceptedAt: timestamp("accepted_at"),
});

// Legacy table — kept to avoid migration, no longer used by app code
export const projectInvites = pgTable("project_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  email: text("email").notNull(),
  role: memberRoleEnum("role").default("viewer").notNull(),
  invitedBy: uuid("invited_by").references(() => users.id).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

// ── Incident Storms ─────────────────────────────────────────────────────────

export const incidentStorms = pgTable("incident_storms", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  status: text("status").notNull().default("active"), // 'active' | 'resolved'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
});

// ── Alerts ────────────────────────────────────────────────────────────────────

export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  stormId: uuid("storm_id").references(() => incidentStorms.id, { onDelete: "set null" }),
  severity: severityEnum("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sourceIntegrations: text("source_integrations").array().notNull().default([]),
  // AI-generated fields
  aiReasoning: text("ai_reasoning"),
  correlationData: jsonb("correlation_data"),
  postmortem: text("postmortem"),
  isRead: boolean("is_read").default(false).notNull(),
  isResolved: boolean("is_resolved").default(false).notNull(),
  /** Alert type: error (default), security, log */
  alertType: text("alert_type").default("error").notNull(),
  /** Error fingerprint for outcome tracking (SHA-256 of normalized error) */
  fingerprint: text("fingerprint"),
  sentAt: timestamp("sent_at"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Notifications ─────────────────────────────────────────────────────────────

export const notificationChannels = pgTable("notification_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  type: notifTypeEnum("type").notNull(),
  config: jsonb("config").notNull(), // bot_token, chat_id, webhook_url, etc.
  isActive: boolean("is_active").default(true).notNull(),
  minSeverity: text("min_severity").default("info").notNull(), // 'critical' | 'warning' | 'info'
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notificationLogs = pgTable("notification_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  channelId: uuid("channel_id").references(() => notificationChannels.id).notNull(),
  status: text("status").notNull(), // 'sent' | 'failed' | 'pending'
  error: text("error"),
  sentAt: timestamp("sent_at").defaultNow(),
  openedAt: timestamp("opened_at"),
  clickedAt: timestamp("clicked_at"),
});

// ── Email suppression list ────────────────────────────────────────────────────

export const emailSuppressions = pgTable("email_suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  reason: text("reason").notNull(), // 'bounce' | 'complaint' | 'unsubscribe'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Notification queue ───────────────────────────────────────────────────────

export const notificationQueue = pgTable("notification_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  channelId: uuid("channel_id").references(() => notificationChannels.id, { onDelete: "cascade" }).notNull(),
  status: text("status").notNull().default("pending"), // 'pending' | 'processing' | 'sent' | 'failed'
  priority: integer("priority").default(1).notNull(), // 0=critical, 1=warning, 2=info
  attempts: integer("attempts").default(0).notNull(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  nextRetry: timestamp("next_retry").defaultNow().notNull(),
});

// ── Encrypted API keys ────────────────────────────────────────────────────────

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  service: text("service").notNull(), // 'claude' | 'openai' | 'github' | 'vercel' etc.
  keyEncrypted: text("key_encrypted").notNull(),
  keyHash: text("key_hash"), // SHA-256 hash for O(1) auth lookup (cli/mobile/desktop tokens)
  metadata: jsonb("metadata"), // non-sensitive context (org slug, etc.)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Password reset tokens ────────────────────────────────────────────────────

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Email verification tokens ────────────────────────────────────────────────

export const emailVerifications = pgTable("email_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Alert comments ──────────────────────────────────────────────────────────

export const alertComments = pgTable("alert_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Maintenance windows ─────────────────────────────────────────────────────

export const maintenanceWindows = pgTable("maintenance_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Escalation rules ────────────────────────────────────────────────────────

export const escalationRules = pgTable("escalation_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  targetType: text("target_type").notNull().default("channel"), // 'channel' | 'on_call_primary' | 'on_call_secondary'
  channelId: uuid("channel_id").references(() => notificationChannels.id, { onDelete: "cascade" }),
  delaySec: integer("delay_sec").notNull().default(1800), // 30 min default
  minSeverity: text("min_severity").notNull().default("critical"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Audit log ───────────────────────────────────────────────────────────────

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  action: text("action").notNull(), // 'project.create' | 'integration.connect' | 'alert.resolve' etc.
  resource: text("resource").notNull(), // 'project' | 'integration' | 'alert' | 'member' etc.
  resourceId: uuid("resource_id"),
  metadata: jsonb("metadata"), // extra context
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Outgoing webhooks ───────────────────────────────────────────────────────

export const outgoingWebhooks = pgTable("outgoing_webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(), // HMAC signing secret
  events: text("events").array().notNull().default([]), // ['alert.created', 'alert.resolved']
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Public status pages ─────────────────────────────────────────────────────

export const statusPages = pgTable("status_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  isPublic: boolean("is_public").default(true).notNull(),
  config: jsonb("config").$type<StatusPageConfig>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type StatusPageConfig = {
  autoCreateIncident?: boolean;
  autoResolve?: boolean;
  notifySubscribers?: boolean;
  minSeverityToPost?: "critical" | "error" | "warning";
};

export const DEFAULT_STATUS_PAGE_CONFIG: StatusPageConfig = {
  autoCreateIncident: false,
  autoResolve: true,
  notifySubscribers: true,
  minSeverityToPost: "critical",
};

// ── Status page incidents ──────────────────────────────────────────────────

export const statusPageIncidents = pgTable("status_page_incidents", {
  id: uuid("id").primaryKey().defaultRandom(),
  statusPageId: uuid("status_page_id").references(() => statusPages.id, { onDelete: "cascade" }).notNull(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
  remediationSessionId: uuid("remediation_session_id").references(() => remediationSessions.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  status: text("status").notNull().default("investigating"),
  // investigating | identified | fixing | monitoring | resolved | regressed
  severity: text("severity").notNull().default("major"),
  // minor | major | critical
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  postmortem: text("postmortem"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const statusPageUpdates = pgTable("status_page_updates", {
  id: uuid("id").primaryKey().defaultRandom(),
  incidentId: uuid("incident_id").references(() => statusPageIncidents.id, { onDelete: "cascade" }).notNull(),
  status: text("status").notNull(),
  message: text("message").notNull(),
  isAutoGenerated: boolean("is_auto_generated").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const statusPageSubscribers = pgTable("status_page_subscribers", {
  id: uuid("id").primaryKey().defaultRandom(),
  statusPageId: uuid("status_page_id").references(() => statusPages.id, { onDelete: "cascade" }).notNull(),
  email: text("email").notNull(),
  verified: boolean("verified").default(false),
  unsubscribeToken: text("unsubscribe_token").notNull().default(sql`gen_random_uuid()`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── AI Remediation sessions ─────────────────────────────────────────────────

export const remediationSessions = pgTable("remediation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: text("status").notNull().default("analyzing"),
  // analyzing | reading_code | generating_fix | pushing | awaiting_ci |
  // ci_passed | ci_failed_retrying | proposing | approved | merging | completed | failed | cancelled
  attempt: integer("attempt").notNull().default(1),
  maxAttempts: integer("max_attempts").notNull().default(3),
  repo: text("repo"),         // "owner/repo"
  branch: text("branch"),       // fix branch name
  baseBranch: text("base_branch"),  // default branch
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  fileChanges: jsonb("file_changes"),   // [{path, content}]
  steps: jsonb("steps").notNull().default([]),
  error: text("error"),
  confidenceScore: integer("confidence_score"),
  selfReviewResult: jsonb("self_review_result"),  // { score, concerns, recommendation }
  mergeStrategy: text("merge_strategy"),           // 'draft_pr' | 'auto_merged'
  mergedCommitSha: text("merged_commit_sha"),
  monitoringUntil: timestamp("monitoring_until", { withTimezone: true }),
  monitoringStatus: text("monitoring_status"),     // 'watching' | 'passed' | 'reverted'
  revertPrUrl: text("revert_pr_url"),
  fingerprint: text("fingerprint"),
  /** Full diagnosis context (Sentry stack traces, Vercel logs, GitHub CI, Datadog) — preserved for replay/training. */
  context: jsonb("context"),
  /** Substrate simulate risk score (0-100). NULL if no recording available. */
  simulateRiskScore: integer("simulate_risk_score"),
  /** Checkpoint phase for crash recovery. Set after each pipeline phase completes. */
  checkpointPhase: text("checkpoint_phase"),
  /** Intermediate data for crash recovery — diagnosis, fix files, etc. */
  checkpointData: jsonb("checkpoint_data"),
  /** Staging deploy ID for orphan cleanup on crash. */
  stagingDeployId: text("staging_deploy_id"),
  /** Embedding of the fix context (diagnosis + files + result) for vector replay. */
  fixEmbedding: vector("fix_embedding"),
  /** When the fix was proposed to the human (status → proposing). Used to compute time-to-decide. */
  proposedAt: timestamp("proposed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type RemediationStep = {
  id: string;
  type: string;
  message: string;
  status: "running" | "completed" | "failed";
  timestamp: string;
};

// ── Cron Locks (prevent concurrent cron invocations) ──────────────────────────

export const cronLocks = pgTable("cron_locks", {
  key: text("key").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ── Remediation Locks (file-level concurrency control) ──────────────────────

export const remediationLocks = pgTable("remediation_locks", {
  repoId: text("repo_id").notNull(),
  filePath: text("file_path").notNull(),
  sessionId: text("session_id").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [{ primaryKey: [t.repoId, t.filePath] }]);

// ── Gate Telemetry (circuit breaker + dashboard) ────────────────────────────

export const gateTelemetry = pgTable("gate_telemetry", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  gateName: text("gate_name").notNull(),
  result: boolean("result").notNull(),
  errorReason: text("error_reason"),
  durationMs: integer("duration_ms"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Failed Fixes (learning from failures) ───────────────────────────────────

export const failedFixes = pgTable("failed_fixes", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  errorFingerprint: text("error_fingerprint").notNull(),
  attemptedFixSummary: text("attempted_fix_summary").notNull(),
  failureReason: text("failure_reason").notNull(),
  filesTouched: jsonb("files_touched").$type<string[]>().default([]),
  failedAt: timestamp("failed_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Confidence Calibration ──────────────────────────────────────────────────

export const confidenceCalibration = pgTable("confidence_calibration", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  predictedConfidence: integer("predicted_confidence").notNull(),
  actualOutcome: boolean("actual_outcome").notNull(),
  diagnosedAt: timestamp("diagnosed_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Remediation Incidents (correlation) ─────────────────────────────────────

export const remediationIncidents = pgTable("remediation_incidents", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  sessionIds: jsonb("session_ids").$type<string[]>().notNull().default([]),
  leadSessionId: text("lead_session_id"),
  rootCause: text("root_cause"),
  status: text("status").notNull().default("open"), // open | resolved | resolved_by_leader
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── TypeScript types ──────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type ProjectInvite = typeof projectInvites.$inferSelect;
export type AlertComment = typeof alertComments.$inferSelect;
export type MaintenanceWindow = typeof maintenanceWindows.$inferSelect;
export type EscalationRule = typeof escalationRules.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type OutgoingWebhook = typeof outgoingWebhooks.$inferSelect;
export type StatusPage = typeof statusPages.$inferSelect;
export type StatusPageIncident = typeof statusPageIncidents.$inferSelect;
export type StatusPageUpdate = typeof statusPageUpdates.$inferSelect;
export type StatusPageSubscriber = typeof statusPageSubscribers.$inferSelect;
export type RemediationSession = typeof remediationSessions.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type OrganizationInvite = typeof organizationInvites.$inferSelect;

// ── Uptime Monitoring ───────────────────────────────────────────────────────

export const uptimeMonitors = pgTable("uptime_monitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  url: text("url").notNull(),
  name: text("name"),
  intervalSec: integer("interval_sec").default(60).notNull(),
  expectedStatus: integer("expected_status").default(200).notNull(),
  timeoutMs: integer("timeout_ms").default(10000).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  isDown: boolean("is_down").default(false).notNull(),
  /** Consecutive failed checks (reset to 0 on success) */
  consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
  /** When auto-heal was last triggered (cooldown: 10 min) */
  healTriggeredAt: timestamp("heal_triggered_at"),
  lastCheckedAt: timestamp("last_checked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const uptimeChecks = pgTable("uptime_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  monitorId: uuid("monitor_id").references(() => uptimeMonitors.id, { onDelete: "cascade" }).notNull(),
  statusCode: integer("status_code"),
  responseTimeMs: integer("response_time_ms"),
  isUp: boolean("is_up").notNull(),
  error: text("error"),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});

export type UptimeMonitor = typeof uptimeMonitors.$inferSelect;
export type UptimeCheck = typeof uptimeChecks.$inferSelect;

// ── On-Call Schedules ───────────────────────────────────────────────────────

export const onCallSchedules = pgTable("on_call_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").default("UTC").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const onCallSlots = pgTable("on_call_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  scheduleId: uuid("schedule_id").references(() => onCallSchedules.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  level: integer("level").notNull().default(1), // 1=Primary, 2=Secondary
  dayStart: integer("day_start").notNull(),
  dayEnd: integer("day_end").notNull(),
  hourStart: integer("hour_start").default(0).notNull(),
  hourEnd: integer("hour_end").default(23).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const onCallOverrides = pgTable("on_call_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  scheduleId: uuid("schedule_id").references(() => onCallSchedules.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  level: integer("level").notNull().default(1),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type OnCallSchedule = typeof onCallSchedules.$inferSelect;
export type OnCallSlot = typeof onCallSlots.$inferSelect;
export type OnCallOverride = typeof onCallOverrides.$inferSelect;
export type IncidentStorm = typeof incidentStorms.$inferSelect;

// ── Blog subscribers ──────────────────────────────────────────────────────────

export const blogSubscribers = pgTable("blog_subscribers", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  unsubscribeToken: text("unsubscribe_token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BlogSubscriber = typeof blogSubscribers.$inferSelect;

// ── Blog ──────────────────────────────────────────────────────────────────────

export const blogPosts = pgTable("blog_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  content: text("content").notNull().default(""),
  tag: text("tag").notNull().default("Update"),
  isPublished: boolean("is_published").default(false).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BlogPost = typeof blogPosts.$inferSelect;

// ── Substrate Recordings ─────────────────────────────────────────────────────

export const substrateRecordings = pgTable("substrate_recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  recordingId: text("recording_id").notNull().unique(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  command: text("command"),
  runtime: text("runtime").default("node"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  eventCount: integer("event_count").default(0),
  durationMs: integer("duration_ms"),
  categories: jsonb("categories"),
  context: text("context"),
  events: jsonb("events"),
  uiEvents: jsonb("ui_events"), // rrweb session recording (clicks, inputs, navigation)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Fix Replay: Error patterns + Community fixes ────────────────────────────

export const errorPatterns = pgTable("error_patterns", {
  id: uuid("id").primaryKey().defaultRandom(),
  fingerprint: text("fingerprint").notNull().unique(),
  patternText: text("pattern_text").notNull(),
  category: text("category").notNull(),
  framework: text("framework"),
  language: text("language"),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  /** Truncated context from the original diagnosis (stack trace + CI error) for pattern replay. */
  contextSummary: text("context_summary"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const communityFixes = pgTable("community_fixes", {
  id: uuid("id").primaryKey().defaultRandom(),
  patternId: uuid("pattern_id").references(() => errorPatterns.id, { onDelete: "cascade" }).notNull(),
  fixApproach: text("fix_approach").notNull(),
  fixDescription: text("fix_description").notNull(),
  filesChangedSummary: text("files_changed_summary"),
  avgConfidence: integer("avg_confidence").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  totalApplications: integer("total_applications").notNull().default(0),
  contributedBy: uuid("contributed_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fixRatings = pgTable("fix_ratings", {
  id: uuid("id").primaryKey().defaultRandom(),
  fixId: uuid("fix_id").references(() => communityFixes.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  worked: boolean("worked").notNull(),
  rating: integer("rating"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ErrorPattern = typeof errorPatterns.$inferSelect;
export type CommunityFix = typeof communityFixes.$inferSelect;
export type FixRating = typeof fixRatings.$inferSelect;

// ── Prediction tracking ──────────────────────────────────────────────────────

export const predictions = pgTable("predictions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  prNumber: integer("pr_number").notNull(),
  repo: text("repo").notNull(), // "owner/repo"
  /** Predicted error title */
  predictedError: text("predicted_error").notNull(),
  /** File and line predicted */
  predictedFile: text("predicted_file"),
  predictedLine: integer("predicted_line"),
  /** AI confidence 0-100 */
  confidence: integer("confidence").notNull(),
  /** Risk level from prediction engine */
  riskLevel: text("risk_level").notNull(), // 'low' | 'medium' | 'high' | 'critical'
  /** Shadow replay risk score 0-100 (null if replay didn't run) */
  replayRiskScore: integer("replay_risk_score"),
  /** Outcome after deploy: 'pending' | 'correct' | 'false_positive' | 'false_negative' */
  outcome: text("outcome").default("pending").notNull(),
  /** Alert ID if the predicted error actually occurred */
  matchedAlertId: uuid("matched_alert_id").references(() => alerts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export type Prediction = typeof predictions.$inferSelect;

// ── CLI Auth (device flow) ────────────────────────────────────────────────────

export const cliPendingCodes = pgTable("cli_pending_codes", {
  id:        uuid("id").primaryKey().defaultRandom(),
  code:      text("code").notNull().unique(),
  userId:    uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  approved:  boolean("approved").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── MCP Access Tokens ────────────────────────────────────────────────────────

export const mcpTokens = pgTable("mcp_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  /** SHA-256 hash of the token. Raw token is shown once on creation, never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  scopes: text("scopes").array().notNull().default(sql`'{read}'`),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type McpToken = typeof mcpTokens.$inferSelect;

// ── MCP OAuth Clients (registered apps allowed to use OAuth) ─────────────────

export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── MCP OAuth Codes (PKCE authorization flow) ────────────────────────────────

export const mcpOauthCodes = pgTable("mcp_oauth_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  clientId: text("client_id").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Telegram User Links ──────────────────────────────────────────────────────

export const telegramUserLinks = pgTable("telegram_user_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  telegramUserId: text("telegram_user_id").notNull(),
  chatId: text("chat_id").notNull(),
  botToken: text("bot_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Telegram Message Tracking (thread context equivalent) ────────────────────

export const telegramMessageLinks = pgTable("telegram_message_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatId: text("chat_id").notNull(),
  messageId: integer("message_id").notNull(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }),
  stormId: uuid("storm_id").references(() => incidentStorms.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("alert"), // 'alert' | 'incident' | 'deploy'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Rate Limiting ────────────────────────────────────────────────────────────

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(1),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});

// ── Slack Bot ────────────────────────────────────────────────────────────────

export const slackInstallations = pgTable("slack_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().unique(),
  teamName: text("team_name").notNull(),
  botToken: text("bot_token").notNull(), // encrypted
  botUserId: text("bot_user_id").notNull(),
  scopes: text("scopes").array().notNull().default(sql`'{}'`),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const slackChannelMappings = pgTable("slack_channel_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: uuid("installation_id").notNull().references(() => slackInstallations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  channelName: text("channel_name").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const slackMessageThreads = pgTable("slack_message_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: uuid("installation_id").notNull().references(() => slackInstallations.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts").notNull(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }),
  stormId: uuid("storm_id").references(() => incidentStorms.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("alert"), // 'alert' | 'incident' | 'deploy'
  createdAt: timestamp("created_at").defaultNow(),
});

export const slackUserLinks = pgTable("slack_user_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  installationId: uuid("installation_id").notNull().references(() => slackInstallations.id, { onDelete: "cascade" }),
  slackUserId: text("slack_user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const deployMonitors = pgTable("deploy_monitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts").notNull(),
  installationId: uuid("installation_id").notNull().references(() => slackInstallations.id, { onDelete: "cascade" }),
  deploySource: text("deploy_source").notNull(), // 'vercel' | 'github'
  deployId: text("deploy_id"),
  checkAt: timestamp("check_at").notNull(),
  status: text("status").default("pending").notNull(), // 'pending' | 'checked'
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Code Intelligence (Code RAG) ────────────────────────────────────────────

export const codeRepoStatusEnum = pgEnum("code_repo_status", [
  "pending",
  "indexing",
  "ready",
  "failed",
]);

export const chunkTypeEnum = pgEnum("chunk_type", [
  "function",
  "class",
  "method",
  "module",
  "type",
]);

export const depTypeEnum = pgEnum("dep_type", [
  "calls",
  "imports",
  "extends",
  "implements",
]);

export const codeRepositories = pgTable("code_repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  githubOwner: text("github_owner").notNull(),
  githubRepo: text("github_repo").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  lastIndexedCommit: text("last_indexed_commit"),
  lastIndexedAt: timestamp("last_indexed_at"),
  totalChunks: integer("total_chunks").notNull().default(0),
  status: codeRepoStatusEnum("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type CodeRepository = typeof codeRepositories.$inferSelect;
export type NewCodeRepository = typeof codeRepositories.$inferInsert;

export const codeChunks = pgTable(
  "code_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => codeRepositories.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    chunkType: chunkTypeEnum("chunk_type").notNull(),
    name: text("name").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    code: text("code").notNull(),
    docstring: text("docstring"),
    embedding: vector("embedding"),
    language: text("language").notNull(),
    dependencies: text("dependencies").array().notNull().default([]),
    tsv: tsvector("tsv"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_code_chunks_repo").on(table.repoId),
    index("idx_code_chunks_file").on(table.repoId, table.filePath),
  ]
);

export type CodeChunk = typeof codeChunks.$inferSelect;
export type NewCodeChunk = typeof codeChunks.$inferInsert;

export const codeDependencies = pgTable(
  "code_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceChunkId: uuid("source_chunk_id")
      .notNull()
      .references(() => codeChunks.id, { onDelete: "cascade" }),
    targetChunkId: uuid("target_chunk_id")
      .notNull()
      .references(() => codeChunks.id, { onDelete: "cascade" }),
    dependencyType: depTypeEnum("dependency_type").notNull(),
  },
  (table) => [
    index("idx_code_deps_source").on(table.sourceChunkId),
    index("idx_code_deps_target").on(table.targetChunkId),
  ]
);

export type CodeDependency = typeof codeDependencies.$inferSelect;
export type NewCodeDependency = typeof codeDependencies.$inferInsert;
