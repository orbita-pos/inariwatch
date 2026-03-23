import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";

// ── Enums ─────────────────────────────────────────────────────────────────────

export const planEnum = pgEnum("plan", ["free", "pro"]);
export const severityEnum = pgEnum("severity", ["critical", "warning", "info"]);
export const notifTypeEnum = pgEnum("notification_type", ["telegram", "whatsapp", "email", "slack", "push"]);
export const integrationEnum = pgEnum("integration", ["github", "vercel", "sentry", "postgres", "git", "npm", "datadog", "uptime"]);

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

  activeOrgId: uuid("active_org_id").references(() => organizations.id, { onDelete: "set null" }),

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AutoMergeConfig = {
  enabled: boolean;
  minConfidence: number;      // 0-100
  maxLinesChanged: number;
  requireSelfReview: boolean;
  postMergeMonitor: boolean;
  autoRevert: boolean;
};

export const DEFAULT_AUTO_MERGE_CONFIG: AutoMergeConfig = {
  enabled: false,
  minConfidence: 90,
  maxLinesChanged: 50,
  requireSelfReview: true,
  postMergeMonitor: true,
  autoRevert: true,
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
  sentAt: timestamp("sent_at"),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
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

// ── Rate Limiting ────────────────────────────────────────────────────────────

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(1),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});
