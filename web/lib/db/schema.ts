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

export const planEnum          = pgEnum("plan",              ["free", "pro", "team"]);
export const severityEnum      = pgEnum("severity",          ["critical", "warning", "info"]);
export const notifTypeEnum     = pgEnum("notification_type", ["telegram", "whatsapp", "email", "slack"]);
export const integrationEnum   = pgEnum("integration",       ["github", "vercel", "sentry", "postgres", "git", "npm"]);

// ── Users ─────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:               uuid("id").primaryKey().defaultRandom(),
  email:            text("email").notNull().unique(),
  name:             text("name"),
  passwordHash:     text("password_hash"),
  plan:             planEnum("plan").default("free").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubId:      text("stripe_sub_id"),
  emailVerifiedAt:  timestamp("email_verified_at"),
  totpSecret:       text("totp_secret"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  aiModels:         jsonb("ai_models"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});

// NextAuth accounts (OAuth providers)
export const accounts = pgTable("accounts", {
  id:                uuid("id").primaryKey().defaultRandom(),
  userId:            uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  provider:          text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  type:              text("type").notNull(),
  accessToken:       text("access_token"),
  refreshToken:      text("refresh_token"),
  expiresAt:         integer("expires_at"),
});

// ── Organizations (workspaces) ────────────────────────────────────────────────

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member"]);

export const organizations = pgTable("organizations", {
  id:        uuid("id").primaryKey().defaultRandom(),
  name:      text("name").notNull(),
  slug:      text("slug").notNull().unique(),
  ownerId:   uuid("owner_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const organizationMembers = pgTable("organization_members", {
  id:             uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId:         uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role:           orgRoleEnum("role").default("member").notNull(),
  joinedAt:       timestamp("joined_at").defaultNow().notNull(),
});

export const organizationInvites = pgTable("organization_invites", {
  id:             uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  email:          text("email").notNull(),
  role:           orgRoleEnum("role").default("member").notNull(),
  invitedBy:      uuid("invited_by").references(() => users.id).notNull(),
  token:          text("token").notNull().unique(),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  expiresAt:      timestamp("expires_at").notNull(),
});

// ── Projects ──────────────────────────────────────────────────────────────────

export const projects = pgTable("projects", {
  id:             uuid("id").primaryKey().defaultRandom(),
  userId:         uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  name:           text("name").notNull(),
  slug:           text("slug").notNull().unique(),
  description:    text("description"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
});

export const projectIntegrations = pgTable("project_integrations", {
  id:              uuid("id").primaryKey().defaultRandom(),
  projectId:       uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  service:         text("service").notNull(),
  // Encrypted JSON with tokens, repos, etc.
  configEncrypted: jsonb("config_encrypted"),
  webhookSecret:   text("webhook_secret"),
  isActive:        boolean("is_active").default(true).notNull(),
  lastCheckedAt:   timestamp("last_checked_at"),
  lastSuccessAt:   timestamp("last_success_at"),
  errorCount:      integer("error_count").default(0).notNull(),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

// ── Project Members ─────────────────────────────────────────────────────────

export const memberRoleEnum = pgEnum("member_role", ["admin", "viewer"]);

export const projectMembers = pgTable("project_members", {
  id:         uuid("id").primaryKey().defaultRandom(),
  projectId:  uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId:     uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role:       memberRoleEnum("role").default("viewer").notNull(),
  invitedBy:  uuid("invited_by").references(() => users.id).notNull(),
  invitedAt:  timestamp("invited_at").defaultNow().notNull(),
  acceptedAt: timestamp("accepted_at"),
});

// ── Project Invites ─────────────────────────────────────────────────────────

export const projectInvites = pgTable("project_invites", {
  id:        uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  email:     text("email").notNull(),
  role:      memberRoleEnum("role").default("viewer").notNull(),
  invitedBy: uuid("invited_by").references(() => users.id).notNull(),
  token:     text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

// ── Alerts ────────────────────────────────────────────────────────────────────

export const alerts = pgTable("alerts", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  projectId:          uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  severity:           severityEnum("severity").notNull(),
  title:              text("title").notNull(),
  body:               text("body").notNull(),
  sourceIntegrations: text("source_integrations").array().notNull().default([]),
  // AI-generated fields
  aiReasoning:        text("ai_reasoning"),
  correlationData:    jsonb("correlation_data"),
  postmortem:         text("postmortem"),
  isRead:             boolean("is_read").default(false).notNull(),
  isResolved:         boolean("is_resolved").default(false).notNull(),
  sentAt:             timestamp("sent_at"),
  createdAt:          timestamp("created_at").defaultNow().notNull(),
});

// ── Notifications ─────────────────────────────────────────────────────────────

export const notificationChannels = pgTable("notification_channels", {
  id:          uuid("id").primaryKey().defaultRandom(),
  userId:      uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  type:        notifTypeEnum("type").notNull(),
  config:      jsonb("config").notNull(), // bot_token, chat_id, webhook_url, etc.
  isActive:    boolean("is_active").default(true).notNull(),
  minSeverity: text("min_severity").default("info").notNull(), // 'critical' | 'warning' | 'info'
  verifiedAt:  timestamp("verified_at"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});

export const notificationLogs = pgTable("notification_logs", {
  id:        uuid("id").primaryKey().defaultRandom(),
  alertId:   uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  channelId: uuid("channel_id").references(() => notificationChannels.id).notNull(),
  status:    text("status").notNull(), // 'sent' | 'failed' | 'pending'
  error:     text("error"),
  sentAt:    timestamp("sent_at").defaultNow(),
  openedAt:  timestamp("opened_at"),
  clickedAt: timestamp("clicked_at"),
});

// ── Email suppression list ────────────────────────────────────────────────────

export const emailSuppressions = pgTable("email_suppressions", {
  id:        uuid("id").primaryKey().defaultRandom(),
  email:     text("email").notNull().unique(),
  reason:    text("reason").notNull(), // 'bounce' | 'complaint' | 'unsubscribe'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Notification queue ───────────────────────────────────────────────────────

export const notificationQueue = pgTable("notification_queue", {
  id:        uuid("id").primaryKey().defaultRandom(),
  alertId:   uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  channelId: uuid("channel_id").references(() => notificationChannels.id, { onDelete: "cascade" }).notNull(),
  status:    text("status").notNull().default("pending"), // 'pending' | 'processing' | 'sent' | 'failed'
  priority:  integer("priority").default(1).notNull(), // 0=critical, 1=warning, 2=info
  attempts:  integer("attempts").default(0).notNull(),
  error:     text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  nextRetry: timestamp("next_retry").defaultNow().notNull(),
});

// ── Encrypted API keys ────────────────────────────────────────────────────────

export const apiKeys = pgTable("api_keys", {
  id:           uuid("id").primaryKey().defaultRandom(),
  userId:       uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  service:      text("service").notNull(), // 'claude' | 'openai' | 'github' | 'vercel' etc.
  keyEncrypted: text("key_encrypted").notNull(),
  metadata:     jsonb("metadata"), // non-sensitive context (org slug, etc.)
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});

// ── Password reset tokens ────────────────────────────────────────────────────

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id:        uuid("id").primaryKey().defaultRandom(),
  userId:    uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  token:     text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt:    timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Email verification tokens ────────────────────────────────────────────────

export const emailVerifications = pgTable("email_verifications", {
  id:        uuid("id").primaryKey().defaultRandom(),
  userId:    uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  token:     text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Alert comments ──────────────────────────────────────────────────────────

export const alertComments = pgTable("alert_comments", {
  id:        uuid("id").primaryKey().defaultRandom(),
  alertId:   uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  userId:    uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  body:      text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Maintenance windows ─────────────────────────────────────────────────────

export const maintenanceWindows = pgTable("maintenance_windows", {
  id:        uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  title:     text("title").notNull(),
  startsAt:  timestamp("starts_at").notNull(),
  endsAt:    timestamp("ends_at").notNull(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Escalation rules ────────────────────────────────────────────────────────

export const escalationRules = pgTable("escalation_rules", {
  id:          uuid("id").primaryKey().defaultRandom(),
  projectId:   uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  channelId:   uuid("channel_id").references(() => notificationChannels.id, { onDelete: "cascade" }).notNull(),
  delaySec:    integer("delay_sec").notNull().default(1800), // 30 min default
  minSeverity: text("min_severity").notNull().default("critical"),
  isActive:    boolean("is_active").default(true).notNull(),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});

// ── Audit log ───────────────────────────────────────────────────────────────

export const auditLogs = pgTable("audit_logs", {
  id:         uuid("id").primaryKey().defaultRandom(),
  userId:     uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  action:     text("action").notNull(), // 'project.create' | 'integration.connect' | 'alert.resolve' etc.
  resource:   text("resource").notNull(), // 'project' | 'integration' | 'alert' | 'member' etc.
  resourceId: uuid("resource_id"),
  metadata:   jsonb("metadata"), // extra context
  ipAddress:  text("ip_address"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
});

// ── Outgoing webhooks ───────────────────────────────────────────────────────

export const outgoingWebhooks = pgTable("outgoing_webhooks", {
  id:        uuid("id").primaryKey().defaultRandom(),
  userId:    uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  url:       text("url").notNull(),
  secret:    text("secret").notNull(), // HMAC signing secret
  events:    text("events").array().notNull().default([]), // ['alert.created', 'alert.resolved']
  isActive:  boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Public status pages ─────────────────────────────────────────────────────

export const statusPages = pgTable("status_pages", {
  id:        uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  slug:      text("slug").notNull().unique(),
  title:     text("title").notNull(),
  isPublic:  boolean("is_public").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── AI Remediation sessions ─────────────────────────────────────────────────

export const remediationSessions = pgTable("remediation_sessions", {
  id:           uuid("id").primaryKey().defaultRandom(),
  alertId:      uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  projectId:    uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId:       uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status:       text("status").notNull().default("analyzing"),
  // analyzing | reading_code | generating_fix | pushing | awaiting_ci |
  // ci_passed | ci_failed_retrying | proposing | approved | merging | completed | failed | cancelled
  attempt:      integer("attempt").notNull().default(1),
  maxAttempts:  integer("max_attempts").notNull().default(3),
  repo:         text("repo"),         // "owner/repo"
  branch:       text("branch"),       // fix branch name
  baseBranch:   text("base_branch"),  // default branch
  prUrl:        text("pr_url"),
  prNumber:     integer("pr_number"),
  fileChanges:  jsonb("file_changes"),   // [{path, content}]
  steps:        jsonb("steps").notNull().default([]),
  error:        text("error"),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type RemediationStep = {
  id: string;
  type: string;
  message: string;
  status: "running" | "completed" | "failed";
  timestamp: string;
};

// ── TypeScript types ──────────────────────────────────────────────────────────

export type User              = typeof users.$inferSelect;
export type Project           = typeof projects.$inferSelect;
export type Alert             = typeof alerts.$inferSelect;
export type NewAlert          = typeof alerts.$inferInsert;
export type ProjectMember     = typeof projectMembers.$inferSelect;
export type ProjectInvite     = typeof projectInvites.$inferSelect;
export type AlertComment      = typeof alertComments.$inferSelect;
export type MaintenanceWindow = typeof maintenanceWindows.$inferSelect;
export type EscalationRule    = typeof escalationRules.$inferSelect;
export type AuditLog          = typeof auditLogs.$inferSelect;
export type OutgoingWebhook   = typeof outgoingWebhooks.$inferSelect;
export type StatusPage          = typeof statusPages.$inferSelect;
export type RemediationSession   = typeof remediationSessions.$inferSelect;
export type Organization         = typeof organizations.$inferSelect;
export type OrganizationMember   = typeof organizationMembers.$inferSelect;
export type OrganizationInvite   = typeof organizationInvites.$inferSelect;
