import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  numeric,
  doublePrecision,
  real,
  bigint,
  index,
  uniqueIndex,
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
export const integrationEnum = pgEnum("integration", [
  "github", "vercel", "sentry", "postgres", "git", "npm", "datadog", "uptime", "expo",
  // Hosting providers — see web/lib/providers/rollback/ for implementations.
  // Vercel/Netlify/Cloudflare Pages/Render are fully implemented.
  // Railway/Fly are stubs until someone asks for them.
  "netlify", "cloudflare-pages", "render", "railway", "fly",
]);

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

  /** Optional monthly budget cap in USD. Triggers notifications at 80% / 100%. */
  aiBudgetMonthlyUsd: numeric("ai_budget_monthly_usd", { precision: 10, scale: 2 }),

  // ── Stripe billing ───────────────────────────────────────────────────────
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status"),
  // 'active' | 'past_due' | 'canceled' | 'incomplete' | 'trialing'
  subscriptionPeriodEnd: timestamp("subscription_period_end", { withTimezone: true }),
  subscriptionCancelAtPeriodEnd: boolean("subscription_cancel_at_period_end").default(false),

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
  /**
   * Origin allowlist for browser-facing public endpoints (Replay V2
   * ingest + classify-pii). Empty array = allow any Origin (preserves the
   * pre-0048 behaviour so no existing project breaks when the column ships).
   * Populated array = strict — requests whose `Origin` header isn't in the
   * list are rejected with 403. Supports one wildcard subdomain per entry,
   * e.g. `https://*.example.com`.
   */
  allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'`),
  /**
   * Replay V2 per-project configuration. Empty `{}` means "use hardcoded
   * defaults from DEFAULT_REPLAY_SETTINGS" — keeps migration 0049
   * backward-compatible for projects created before the column shipped.
   */
  replaySettings: jsonb("replay_settings").notNull().default(sql`'{}'::jsonb`),
  /**
   * Default `owner/repo` used at remediation time when the alert doesn't
   * carry a repo of its own (custom webhooks, manually created alerts,
   * sources whose payload can't identify a repo). Migration 0068. Set via
   * Settings → Integrations → GitHub → "Default repository".
   */
  defaultRepo: text("default_repo"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Per-project replay configuration. All fields optional — missing values
 * fall back to `DEFAULT_REPLAY_SETTINGS`.
 */
export type ReplaySettings = {
  /** Master kill-switch. When false, ingest rejects all blocks with 403. */
  enabled?: boolean;
  /** 0-1 — probability an error-triggered session is recorded. Default 1.0. */
  errorSampleRate?: number;
  /**
   * 0-1 — probability a session without errors is recorded. Default 0
   * (we're an error-monitoring SaaS, not UX analytics). Pro plan only —
   * Free plan is locked at 0 at the server action boundary.
   */
  sessionSampleRate?: number;
  /** Seconds of pre-error context kept in the client ring buffer. Default 60. */
  bufferSeconds?: number;
  /** Replay retention days. 7 on Free, up to 90 on Pro. */
  retentionDays?: number;
  /**
   * PII classifier strategy. `"ai"` uses heuristics + server AI on ambiguous
   * fields; `"heuristic"` is client-only; `false` disables and falls back to
   * maskAllInputs. Default `"ai"`.
   */
  piiClassifier?: "ai" | "heuristic" | false;
  /**
   * Phase F privacy toggle. When `true`, the dashboard never returns the
   * raw end-user email — only its sha256 hash. Server still STORES the
   * plain email at ingest (so a customer can flip back without losing
   * data) but the manifest route redacts it on every read.
   *
   * Default `false` matches Sentry/FullStory/Datadog: plain emails make
   * the support workflow ("show me sessions for juan@acme.com") work
   * out of the box. Privacy-conscious customers flip this on and the
   * raw email never leaves Postgres.
   */
  hashEndUserEmails?: boolean;
  /**
   * Phase I.d — capture request + response bodies for fetch calls. OFF
   * by default because bodies routinely contain auth tokens, PII, and
   * payment data. When enabled, multi-layer protection applies:
   *   - URL denylist (built-in + customer-extensible)
   *   - JSON key denylist (password, token, secret, etc.)
   *   - Content-Type allowlist (only text-ish bodies; skip binary)
   *   - Header redaction (Authorization, Cookie always removed)
   *   - Hard size cap (`networkBodyMaxBytes`)
   */
  captureNetworkBodies?: boolean;
  /**
   * Additional URL substring patterns that should NEVER have their bodies
   * captured (additive to the built-in denylist of /auth, /login, /payment,
   * etc.). Customer-defined for endpoints unique to their app.
   */
  networkUrlDenylist?: string[];
  /**
   * Per-body size cap in bytes. Default 100KB. Hard max enforced at ingest
   * (anything bigger gets truncated by the SDK before sending).
   */
  networkBodyMaxBytes?: number;
  /**
   * "failed" → only capture bodies for status >= 400 or network error.
   * "all"    → capture all responses (much higher volume + PII surface).
   * Default "failed" — best ratio of debug value to risk.
   */
  networkBodyMode?: "failed" | "all";
};

/** Canonical defaults — applied when a project's replay_settings jsonb is empty. */
export const DEFAULT_REPLAY_SETTINGS: Required<ReplaySettings> = {
  enabled: true,
  errorSampleRate: 1.0,
  sessionSampleRate: 0.0,
  bufferSeconds: 60,
  retentionDays: 7,
  piiClassifier: "ai",
  hashEndUserEmails: false,
  captureNetworkBodies: false,
  networkUrlDenylist: [],
  networkBodyMaxBytes: 100_000,
  networkBodyMode: "failed",
};

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
  lastErrorAt: timestamp("last_error_at"),
  lastErrorMessage: text("last_error_message"),
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
  /**
   * Why AI auto-analyze was skipped, if it was. Null = AI ran (or hasn't
   * been attempted yet). Values: 'quota' (user hit per-feature limit),
   * 'platform_budget' (daily platform AI kill-switch fired), 'no_key'
   * (no AI key configured at all). Used by the alert detail page to
   * render a contextual banner instead of leaving the user wondering
   * why their alert has no diagnosis.
   */
  aiSkippedReason: text("ai_skipped_reason"),
  correlationData: jsonb("correlation_data"),
  postmortem: text("postmortem"),
  isRead: boolean("is_read").default(false).notNull(),
  isResolved: boolean("is_resolved").default(false).notNull(),
  /** Alert type: error (default), security, log */
  alertType: text("alert_type").default("error").notNull(),
  /** Error fingerprint for outcome tracking (SHA-256 of normalized error) */
  fingerprint: text("fingerprint"),
  // Phase H — link to the replay session whose error captured this alert
  // (when one exists). Set by /api/replay/ingest when a block carries an
  // errorFingerprint matching this alert. ON DELETE SET NULL — retention
  // sweep must not cascade-delete the alert.
  replaySessionId: uuid("replay_session_id"),
  // VAR Q1 — raw session id from X-IW-Session-Id header. Independent of
  // replaySessionId (uuid FK) so we can correlate even before a replay
  // row exists. See migration 0057.
  sessionId: text("session_id"),
  /**
   * Canonical `owner/repo` resolved at webhook ingest (migration 0068).
   * Replaces run-time fuzzy extraction in remediate.ts. NULL for alerts
   * written before the migration — the backfill script in
   * `scripts/backfill-alert-repo.ts` populates those. Sources that can't
   * determine the repo (custom webhooks, manual alerts) fall back to
   * `projects.default_repo` at remediation time.
   */
  repo: text("repo"),
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
  /** VAR Q3 Phase 2 — EAP receipt ID (64-char hex Merkle root). Populated
   *  by eap-attestation.service after successful remediation when a
   *  substrate recording is available. Null for remediations without a
   *  recording or that predate Phase 2. Drives the "View attestation"
   *  link on the alert detail page. */
  eapReceiptId: text("eap_receipt_id"),
  /** Preview Fix — backpointer to the preview_sessions row created for this
   *  remediation. Nullable: populated on first `POST /api/alerts/:id/preview`.
   *  The alert detail page reads this alongside the rest of the remediation
   *  so it can render the PreviewPanel without a second query. */
  previewSessionId: uuid("preview_session_id"),
  /** Timestamp of the first preview creation. Drives "preview shipped X days ago" UI. */
  previewEnabledAt: timestamp("preview_enabled_at", { withTimezone: true }),
  // ── Fase 1 telemetry (migration 0069) ────────────────────────────────
  /** Which tier handled the remediation: '0' | '1' | '2' | '3' | 'legacy'.
   *  Written by the tier router in Fase 6; NULL for sessions that predate it. */
  tierUsed: text("tier_used"),
  /** How many candidate hypotheses the Tier 2/3 coordinator produced. */
  hypothesisCount: integer("hypothesis_count"),
  /** Cosine similarity [0, 1] of the closest pattern_memory entry. */
  patternMatchScore: real("pattern_match_score"),
  /** Which sandbox executed model-emitted code: 'none' | 'codeact-deno'. */
  sandboxMode: text("sandbox_mode"),
  /** True when Fase C SDK peer mode was active for this remediation. */
  sdkPeerEnabled: boolean("sdk_peer_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Preview Fix (two-tier visual preview of autonomous remediations) ─────────
//
// See migrations/0065_preview_fix.sql for the feature description. Two tables:
//   preview_sessions     — orchestration row per (alert, remediation)
//   preview_predictions  — AI render cache per (alert_id, merged_commit_sha)

export const previewPredictions = pgTable("preview_predictions", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id")
    .references(() => alerts.id, { onDelete: "cascade" })
    .notNull(),
  mergedCommitSha: text("merged_commit_sha").notNull(),
  /** Claude-predicted + DOMPurify-sanitized HTML. Set as <iframe srcDoc>. */
  predictedHtml: text("predicted_html").notNull(),
  /** Last rrweb FullSnapshot serialized to HTML. Rendered side-by-side as "before". */
  originalHtml: text("original_html").notNull(),
  /** ≤200-char human summary of what the fix visibly changes. */
  diffSummary: text("diff_summary").notNull().default(""),
  /** CSS selectors of modified elements — used by the diff overlay. */
  targetSelectors: jsonb("target_selectors").notNull().default([]),
  /** 0-100 self-reported confidence from the model. */
  confidence: integer("confidence").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const previewSessions = pgTable("preview_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 12-char base32 capability slug. Served at /preview/<slug>. Unguessable. */
  publicSlug: text("public_slug").notNull().unique(),
  alertId: uuid("alert_id")
    .references(() => alerts.id, { onDelete: "cascade" })
    .notNull(),
  projectId: uuid("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  organizationId: uuid("organization_id").references(() => organizations.id, {
    onDelete: "set null",
  }),
  remediationSessionId: uuid("remediation_session_id")
    .references(() => remediationSessions.id, { onDelete: "cascade" })
    .notNull(),
  /** Denormalized from remediationSessions so the public page skips the join. */
  eapReceiptId: text("eap_receipt_id"),

  // ── Tier 1 (live ephemeral deploy on Hetzner) ─────────────────────────────
  /** pending | provisioning | building | running | failed | expired */
  liveStatus: text("live_status").notNull().default("pending"),
  liveDeployId: text("live_deploy_id"),
  liveUrl: text("live_url"),
  liveHostname: text("live_hostname"),
  livePort: integer("live_port"),
  /** Rolled last 32KB of build logs. Secret-scrubbed before write. */
  liveBuildLogs: text("live_build_logs"),
  liveError: text("live_error"),
  liveStartedAt: timestamp("live_started_at", { withTimezone: true }),
  liveReadyAt: timestamp("live_ready_at", { withTimezone: true }),
  liveExpiresAt: timestamp("live_expires_at", { withTimezone: true }),

  // ── Tier 3 (AI-predicted HTML) ────────────────────────────────────────────
  /** pending | rendering | ready | failed | skipped */
  predictionStatus: text("prediction_status").notNull().default("pending"),
  predictionId: uuid("prediction_id").references(() => previewPredictions.id, {
    onDelete: "set null",
  }),
  predictionError: text("prediction_error"),

  // ── Observability / engagement ────────────────────────────────────────────
  buildDurationMs: integer("build_duration_ms"),
  predictionDurationMs: integer("prediction_duration_ms"),
  predictionTokensIn: integer("prediction_tokens_in"),
  predictionTokensOut: integer("prediction_tokens_out"),
  predictionCents: integer("prediction_cents"),
  viewCount: integer("view_count").notNull().default(0),
  tier1ClickCount: integer("tier1_click_count").notNull().default(0),
  tier3ClickCount: integer("tier3_click_count").notNull().default(0),

  /** CDN-served PNG of the running preview. Captured by the Hetzner worker
   *  via Playwright once Tier 1 reaches `running`, uploaded to Vercel Blob,
   *  and referenced here by URL. Persists past the 24h preview TTL so a
   *  share URL tweet or Slack unfurl keeps rendering the image. */
  screenshotUrl: text("screenshot_url"),
  screenshotTakenAt: timestamp("screenshot_taken_at"),
  screenshotWidth: integer("screenshot_width"),
  screenshotHeight: integer("screenshot_height"),
  screenshotError: text("screenshot_error"),

  /** Set by the org owner's "revoke share" action. When non-null the public
   *  slug endpoint returns 410 Gone. Internal lookups by id still resolve. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PreviewSession = typeof previewSessions.$inferSelect;
export type PreviewPrediction = typeof previewPredictions.$inferSelect;

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

export const replaySessions = pgTable("replay_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull().unique(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),

  r2Prefix: text("r2_prefix").notNull(),
  blockCount: integer("block_count").notNull().default(0),
  totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),

  clickSelectors: text("click_selectors").array().notNull().default(sql`'{}'::text[]`),
  urlsVisited: text("urls_visited").array().notNull().default(sql`'{}'::text[]`),
  errorFingerprints: text("error_fingerprints").array().notNull().default(sql`'{}'::text[]`),
  frustrationScore: integer("frustration_score").notNull().default(0),

  browser: text("browser"),
  os: text("os"),
  country: text("country"),
  viewport: jsonb("viewport"),

  aiSummary: text("ai_summary"),
  aiChapters: jsonb("ai_chapters"),

  // Phase E — frustration signals. Both populated by replay-analyze worker
  // after a session ends. Default '[]' means old rows + sessions awaiting
  // analysis read as "no detected frustration" without null guards.
  rageClicks: jsonb("rage_clicks").notNull().default(sql`'[]'::jsonb`),
  deadClicks: jsonb("dead_clicks").notNull().default(sql`'[]'::jsonb`),

  // Phase F — end-user identity. All nullable; populated at ingest from
  // window.__INARIWATCH_USER__ if the customer's app sets it. emailHash
  // is kept beside the plain email so the privacy toggle is a render-time
  // decision (no re-process needed).
  endUserId: text("end_user_id"),
  endUserEmail: text("end_user_email"),
  endUserEmailHash: text("end_user_email_hash"),

  // Phase G — Core Web Vitals snapshot. Object keyed by vital name (LCP,
  // CLS, INP, FCP, TTFB) with `{ value, rating }`. Empty object means
  // "session pre-Phase G OR vitals never reported (e.g. headless / Node)".
  webVitals: jsonb("web_vitals").notNull().default(sql`'{}'::jsonb`),

  // Phase I.c — pre-parsed error stacks for the player's "Errors" panel.
  // Populated by replay-analyze. Empty array = no errors OR session
  // pre-feature. Schema validated by the analyzer (see ResolvedError type).
  resolvedErrors: jsonb("resolved_errors").notNull().default(sql`'[]'::jsonb`),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ReplaySession = typeof replaySessions.$inferSelect;
export type NewReplaySession = typeof replaySessions.$inferInsert;

// ── Replay comments (Day 4 — collab) ─────────────────────────────────────

export const replayComments = pgTable("replay_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull().references(() => replaySessions.sessionId, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Position in the replay this comment is anchored to (session-relative ms). */
  timestampMs: integer("timestamp_ms").notNull(),
  body: text("body").notNull(),
  /** 1-level threading; route layer rejects nested replies. */
  parentId: uuid("parent_id"),
  resolved: boolean("resolved").notNull().default(false),
  /** User ids extracted from `@mentions` at create time. Drives notifications
   *  AND lets the panel render avatars without an extra join. */
  mentionedUserIds: uuid("mentioned_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ReplayComment = typeof replayComments.$inferSelect;
export type NewReplayComment = typeof replayComments.$inferInsert;

export const substrateRecordings = pgTable("substrate_recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  recordingId: text("recording_id").notNull().unique(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  replaySessionId: uuid("replay_session_id").references(() => replaySessions.id, { onDelete: "set null" }),
  // VAR Q1 — raw session id from X-IW-Session-Id header (matches alerts.sessionId).
  sessionId: text("session_id"),
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
  deploySource: text("deploy_source").notNull(), // 'vercel' | 'netlify' | 'cloudflare-pages' | 'render' | 'github'
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

// ── AI usage logs ────────────────────────────────────────────────────────────
// Per-call telemetry for BYOK cost tracking. Each user sees only their own.

export const aiUsageLogs = pgTable(
  "ai_usage_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
    remediationSessionId: uuid("remediation_session_id").references(
      () => remediationSessions.id,
      { onDelete: "set null" }
    ),

    /** What feature triggered the call. */
    feature: text("feature").notNull(),
    // 'auto-analyze' | 'remediation' | 'chat' | 'security-scan'
    // | 'risk-assessment' | 'postmortem' | 'correlate' | 'other'

    provider: text("provider").notNull(),
    // 'openai' | 'claude' | 'gemini' | 'grok' | 'deepseek' | 'groq'
    model: text("model").notNull(),

    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),

    /** Computed cost in USD using pricing at time of call. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 8 }).notNull().default("0"),

    /** True when using the free-tier platform key instead of user's BYOK. */
    isPlatformKey: boolean("is_platform_key").notNull().default(false),

    /** Error message if the call failed — null on success. */
    error: text("error"),

    /** Latency in ms — null if not measured. */
    durationMs: integer("duration_ms"),

    // ── InariLens fields (migration 0056) ────────────────────────────────
    /** Stable per-call id. Indexed UNIQUE — the admin drilldown keys on it. */
    requestId: uuid("request_id").notNull().defaultRandom(),
    /** Full prompt text — nullable for rows logged before capture was wired. */
    prompt: text("prompt"),
    /** Model response text — nullable on error or for pre-capture rows. */
    response: text("response"),
    /**
     * True when the call was served from a local cache (e.g. the redis
     * diagnosis cache). Provider-side prompt caching is separate — see
     * `cachedInputTokens`.
     */
    cached: boolean("cached").notNull().default(false),
    /**
     * For rows generated via the admin replay UI, points back to the
     * original call. Lets the detail page render a lineage list.
     */
    replayOfRequestId: uuid("replay_of_request_id"),

    // ── Fase 1 telemetry (migration 0069) ──────────────────────────────
    /** Zero-based agent turn index within a remediation session. */
    turnNumber: integer("turn_number"),
    /** Time to first token in ms — null until a streaming writer lands. */
    ttftMs: integer("ttft_ms"),
    /** 'classify' | 'explore' | 'fix' | 'review' | 'graders' | 'other'. */
    phase: text("phase"),
    /** Provider-agnostic size bucket: 'nano' | 'mini' | 'standard' | 'reasoning'. */
    modelTier: text("model_tier"),
    /** When this row wraps a single tool invocation, the tool name. */
    toolName: text("tool_name"),
    /** Wall time of the tool execution on the cloud side. */
    toolExecMs: integer("tool_exec_ms"),
    /** Reasoning-token count reported by the provider (GPT-5.x family). */
    reasoningTokens: integer("reasoning_tokens"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_ai_usage_logs_user_created").on(table.userId, table.createdAt),
    index("idx_ai_usage_logs_project_created").on(table.projectId, table.createdAt),
    index("idx_ai_usage_logs_alert").on(table.alertId),
    index("idx_ai_usage_logs_session").on(table.remediationSessionId),
    index("idx_ai_usage_logs_feature").on(table.userId, table.feature, table.createdAt),
    uniqueIndex("idx_ai_usage_logs_request_id").on(table.requestId),
    index("idx_ai_usage_logs_feature_created").on(table.feature, table.createdAt),
    index("idx_ai_usage_logs_replay_of").on(table.replayOfRequestId),
    index("idx_ai_usage_logs_phase_created").on(table.feature, table.phase, table.createdAt),
    index("idx_ai_usage_logs_model_tier_created").on(table.modelTier, table.createdAt),
  ]
);

export type AiUsageLog = typeof aiUsageLogs.$inferSelect;
export type NewAiUsageLog = typeof aiUsageLogs.$inferInsert;

// ── Monthly quota usage ─────────────────────────────────────────────────────
// One row per user per month. Counters increment as features are used.
// Reset by cron on day 1 of each month (creates new row with new period_start).

export const monthlyQuotaUsage = pgTable(
  "monthly_quota_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** First day of the calendar month at 00:00 UTC */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),

    autoAnalyzeUsed: integer("auto_analyze_used").notNull().default(0),
    remediationUsed: integer("remediation_used").notNull().default(0),
    chatUsed: integer("chat_used").notNull().default(0),
    prPredictionUsed: integer("pr_prediction_used").notNull().default(0),
    postmortemUsed: integer("postmortem_used").notNull().default(0),

    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_quota_usage_user_period").on(table.userId, table.periodStart),
  ]
);

export type MonthlyQuotaUsage = typeof monthlyQuotaUsage.$inferSelect;
export type NewMonthlyQuotaUsage = typeof monthlyQuotaUsage.$inferInsert;

// ── Webhook idempotency ─────────────────────────────────────────────────────
// Track processed Stripe/GitHub/etc. webhook events to handle retries.

export const processedWebhookEvents = pgTable("processed_webhook_events", {
  eventId: text("event_id").primaryKey(),
  source: text("source").notNull(), // 'stripe' | 'github' | etc.
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── VAR Q1 — telemetry + What-If cache ──────────────────────────────────────
// Append-only event log driving the VAR roadmap. Every new feature emits at
// least one event. Helper at web/lib/telemetry/product-metrics.ts.

export const productMetrics = pgTable("product_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  event: text("event").notNull(),
  valueNumeric: doublePrecision("value_numeric"),
  valueText: text("value_text"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ProductMetric = typeof productMetrics.$inferSelect;
export type NewProductMetric = typeof productMetrics.$inferInsert;

// What-If replay cache. Deterministic — keyed by (session_id, fix_commit_sha).
// Same inputs always produce same output, so we never invalidate by TTL.

export const whatifReplays = pgTable("whatif_replays", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  fixId: uuid("fix_id"),
  /** { events: [...], divergence_at_ms, summary, error? } — see Substrate replay output. */
  result: jsonb("result").notNull(),
  status: text("status").notNull().default("ready"),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WhatifReplay = typeof whatifReplays.$inferSelect;
export type NewWhatifReplay = typeof whatifReplays.$inferInsert;

// VAR Q2 — Gate 12 "What-If Across Fleet". One row per (alert, remediation,
// fix_commit_sha); the worker updates counters in place as each session's
// replay finishes. Powers the Fleet Verification card + auto-merge gate.

export const fleetVerificationRuns = pgTable("fleet_verification_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  remediationId: uuid("remediation_id")
    .references(() => remediationSessions.id, { onDelete: "cascade" })
    .notNull(),
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
  /** [{ sessionId, outcome, riskScore?, errorCode?, durationMs }] */
  sessionResults: jsonb("session_results").notNull().default(sql`'[]'::jsonb`),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
});

export type FleetVerificationRun = typeof fleetVerificationRuns.$inferSelect;
export type NewFleetVerificationRun = typeof fleetVerificationRuns.$inferInsert;

// VAR Q2 Week 4 — Gate 17 "Performance Regression". Reuses substrate event
// timings from whatif_replays (recorded vs replayed) to detect critical-path
// slowdowns. One row per (alert, remediation, sha).

export const performanceBenchmarks = pgTable("performance_benchmarks", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  remediationId: uuid("remediation_id")
    .references(() => remediationSessions.id, { onDelete: "cascade" })
    .notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  baselineP50Ms: doublePrecision("baseline_p50_ms"),
  baselineP99Ms: doublePrecision("baseline_p99_ms"),
  fixP50Ms: doublePrecision("fix_p50_ms"),
  fixP99Ms: doublePrecision("fix_p99_ms"),
  regressionPercent: doublePrecision("regression_percent"),
  /** [{ url, method, baselineP50Ms, fixP50Ms, regressionPct, sampleSize, slowerThanThreshold }] */
  affectedPaths: jsonb("affected_paths").notNull().default(sql`'[]'::jsonb`),
  thresholdPercent: doublePrecision("threshold_percent").notNull().default(10),
  passed: boolean("passed"),
  status: text("status").notNull().default("running"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type PerformanceBenchmark = typeof performanceBenchmarks.$inferSelect;
export type NewPerformanceBenchmark = typeof performanceBenchmarks.$inferInsert;

// VAR Q2 Week 5 — Gate 13 "Behavioral Drift". Two tables:
//   sessionEndpointMetrics — raw per-(recording, endpoint) samples written
//   by the substrate-extract worker after /api/recordings/upload persists
//   a substrate_recordings row. Baseline percentiles (p50/p95/p99) are
//   computed with percentile_cont over a rolling N-day window at gate time.
//
//   behavioralDriftRuns — one row per (alert, remediation, fix_commit_sha),
//   populated by the behavioral-drift BullMQ job on the low queue. Yellow-
//   light semantics: improvements_detected is populated for wins but never
//   fails the gate. Permissive calibration: only drifted_percent drives
//   pass/fail, structural drift does not push max_drift_score.

export const sessionEndpointMetrics = pgTable("session_endpoint_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  substrateRecordingId: uuid("substrate_recording_id")
    .references(() => substrateRecordings.id, { onDelete: "cascade" })
    .notNull(),
  projectId: uuid("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  /** Normalized route signature, e.g. "POST /api/users/:id". Framework
   *  route template from correlationData takes precedence over the
   *  heuristic normalizer when available. */
  endpointSignature: text("endpoint_signature").notNull(),
  /** First URL observed for this row — debug-only, never grouped by. */
  endpointUrlRaw: text("endpoint_url_raw"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  /** TRUE when the source recording has alert_id NULL and no error-kind
   *  events. Baseline reads filter on this — unhealthy rows are kept for
   *  future trend-delta work but never contribute to the baseline. */
  healthy: boolean("healthy").notNull().default(true),
  latencyMs: doublePrecision("latency_ms"),
  dbQueryCount: integer("db_query_count").notNull().default(0),
  externalHttpCount: integer("external_http_count").notNull().default(0),
  topStatus: integer("top_status"),
  /** Deduped, sorted array of downstream signatures this endpoint called.
   *  Shape: ["postgres:VERB-TABLE", "https://api.stripe.com/v1/charges"] */
  downstreamSignatures: jsonb("downstream_signatures").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type SessionEndpointMetric = typeof sessionEndpointMetrics.$inferSelect;
export type NewSessionEndpointMetric = typeof sessionEndpointMetrics.$inferInsert;

export const behavioralDriftRuns = pgTable("behavioral_drift_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  remediationId: uuid("remediation_id")
    .references(() => remediationSessions.id, { onDelete: "cascade" })
    .notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  bullmqJobId: text("bullmq_job_id"),
  /** Rolling window used for the baseline on THIS run. Stored on the row
   *  so later threshold/window changes stay reproducible. */
  windowDays: integer("window_days").notNull().default(7),
  status: text("status").notNull().default("running"),
  analyzedEndpoints: integer("analyzed_endpoints").notNull().default(0),
  insufficientDataEndpoints: integer("insufficient_data_endpoints").notNull().default(0),
  driftedEndpoints: integer("drifted_endpoints").notNull().default(0),
  improvedEndpoints: integer("improved_endpoints").notNull().default(0),
  /** Worst per-endpoint MAGNITUDE score in [0,1]. Structural drift does NOT
   *  push this value (permissive calibration). Null when analyzed=0. */
  maxDriftScore: doublePrecision("max_drift_score"),
  /** [{ signature, magnitudeScore, hasStructuralDrift, baselineSamples,
   *     fixSamples, structural: { missingDownstreams, newDownstreams,
   *     statusShift }, magnitude: { latencyMs, dbQueryCount,
   *     externalHttpCount } }] — flagged endpoints only. */
  endpointDetails: jsonb("endpoint_details").notNull().default(sql`'[]'::jsonb`),
  /** Same shape as endpointDetails. Directionally-better endpoints only
   *  (wins). Rendered in UI as green signals, NEVER fails the gate. */
  improvementsDetected: jsonb("improvements_detected").notNull().default(sql`'[]'::jsonb`),
  thresholdDriftedPercent: doublePrecision("threshold_drifted_percent").notNull().default(20),
  passed: boolean("passed"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
});

export type BehavioralDriftRun = typeof behavioralDriftRuns.$inferSelect;
export type NewBehavioralDriftRun = typeof behavioralDriftRuns.$inferInsert;

// VAR Q2 Week 8 — Gate 16 "Multi-Environment Coverage". Compares the env
// distribution of fleet sessions replayed by Gate 12 against the full
// project runtime distribution from substrate_recordings. passed=null
// means SKIP (single-env project, fleet run incomplete, or no env data)
// and auto-merge treats null as skip, NOT fail — matches Gate 13/17.

export const multiEnvCoverageRuns = pgTable("multi_env_coverage_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  remediationId: uuid("remediation_id")
    .references(() => remediationSessions.id, { onDelete: "cascade" })
    .notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  bullmqJobId: text("bullmq_job_id"),
  /** Rolling window for the project distribution query. Default 30d. */
  windowDays: integer("window_days").notNull().default(30),
  /** Missing env at >threshold_high_percent traffic = HIGH → fails gate. */
  thresholdHighPercent: numeric("threshold_high_percent").notNull().default("20"),
  /** Missing env between medium and high = MEDIUM → surfaces, never fails. */
  thresholdMediumPercent: numeric("threshold_medium_percent").notNull().default("10"),
  /** { "node@18": { trafficPercent, sessionCount }, ... } */
  projectEnvDistribution: jsonb("project_env_distribution").notNull().default(sql`'{}'::jsonb`),
  fleetEnvDistribution: jsonb("fleet_env_distribution").notNull().default(sql`'{}'::jsonb`),
  /** Node majors missing from fleet above high threshold (fails gate). */
  missingEnvsHigh: text("missing_envs_high").array().notNull().default(sql`'{}'::text[]`),
  /** Node majors missing from fleet in medium band (yellow-light). */
  missingEnvsMedium: text("missing_envs_medium").array().notNull().default(sql`'{}'::text[]`),
  /** Sum of project traffic % for envs present in both distributions. */
  coveragePercent: numeric("coverage_percent"),
  /** Full env vectors from fleet sessions — platform/arch/app_version
   *  stored for future gate logic (v1 only scores on node major). */
  observedEnvVectors: jsonb("observed_env_vectors").notNull().default(sql`'[]'::jsonb`),
  passed: boolean("passed"),
  /** running | completed | failed | skipped. "skipped" + passed=null
   *  is the single-env / fleet-incomplete / no-env-data path. */
  status: text("status").notNull().default("running"),
  skipReason: text("skip_reason"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type MultiEnvCoverageRun = typeof multiEnvCoverageRuns.$inferSelect;
export type NewMultiEnvCoverageRun = typeof multiEnvCoverageRuns.$inferInsert;

// VAR Q2 Week 9 — Gate 14 "Cost Impact". Frozen snapshot of AI spend
// for a remediation, computed from ai_usage_logs. One row per
// (alert, remediation, fix_commit_sha). Passes when
// remediation_cost_usd <= threshold_usd. Skip semantics via passed=null
// when no ai_usage_logs rows exist for the remediation.

export const costImpactRuns = pgTable("cost_impact_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  remediationId: uuid("remediation_id")
    .references(() => remediationSessions.id, { onDelete: "cascade" })
    .notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  /** Sum of ai_usage_logs.cost_usd for this remediation, frozen at eval. */
  remediationCostUsd: numeric("remediation_cost_usd", { precision: 12, scale: 8 })
    .notNull()
    .default("0"),
  tokenCountInput: integer("token_count_input").notNull().default(0),
  tokenCountOutput: integer("token_count_output").notNull().default(0),
  tokenCountCached: integer("token_count_cached").notNull().default(0),
  callCount: integer("call_count").notNull().default(0),
  /** { "<feature>": { costUsd, inputTokens, outputTokens, callCount } } */
  costBreakdown: jsonb("cost_breakdown").notNull().default(sql`'{}'::jsonb`),
  thresholdUsd: numeric("threshold_usd", { precision: 12, scale: 8 }).notNull().default("1"),
  passed: boolean("passed"),
  status: text("status").notNull().default("running"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type CostImpactRun = typeof costImpactRuns.$inferSelect;
export type NewCostImpactRun = typeof costImpactRuns.$inferInsert;

// VAR Q2 Week 12 — Progressive Rollout state machine. 1% → 10% → 50%
// → 100% with per-stage health checks. v1 is manual-advance (operator
// clicks "next stage") with automatic rollback on regression. Auto-
// advance via cron is a v2 addition over the same table.

export const rolloutRuns = pgTable("rollout_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  remediationId: uuid("remediation_id")
    .references(() => remediationSessions.id, { onDelete: "cascade" })
    .notNull(),
  fixCommitSha: text("fix_commit_sha").notNull(),
  /** pending | canary_1 | canary_10 | canary_50 | full_100 | complete
   *  | reverted | failed */
  currentStage: text("current_stage").notNull().default("pending"),
  /** When the CURRENT stage started — reset on every advance. */
  stageStartedAt: timestamp("stage_started_at", { withTimezone: true }).defaultNow().notNull(),
  /** [{ stage, startedAt, endedAt, outcome, metrics, triggeredBy }] */
  stageHistory: jsonb("stage_history").notNull().default(sql`'[]'::jsonb`),
  autoRollbackEnabled: boolean("auto_rollback_enabled").notNull().default(true),
  rollbackReason: text("rollback_reason"),
  rollbackPrUrl: text("rollback_pr_url"),
  thresholdNewErrors: integer("threshold_new_errors").notNull().default(0),
  thresholdUptimeFailures: integer("threshold_uptime_failures").notNull().default(1),
  thresholdFingerprintRegressions: integer("threshold_fingerprint_regressions").notNull().default(0),
  status: text("status").notNull().default("active"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type RolloutRun = typeof rolloutRuns.$inferSelect;
export type NewRolloutRun = typeof rolloutRuns.$inferInsert;

// ── Fase 1 telemetry — sandbox_audit_log (migration 0069) ──────────────────
//
// One row per CodeAct sandbox invocation (Fase 5). Populated by the
// Deno + Pyodide runner in worker/src/sandbox/*. The code itself is not
// stored here to keep the table small and to preserve PII scrubbing;
// code_hash is a SHA-256 hex of the source so duplicate invocations can
// be correlated.

export const sandboxAuditLog = pgTable(
  "sandbox_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").references(() => remediationSessions.id, { onDelete: "set null" }),
    aiUsageLogId: uuid("ai_usage_log_id").references(() => aiUsageLogs.id, { onDelete: "set null" }),
    codeHash: text("code_hash").notNull(),
    purpose: text("purpose").notNull(),
    resultSizeBytes: integer("result_size_bytes").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    success: boolean("success").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_sandbox_audit_log_session_created").on(table.sessionId, table.createdAt),
    index("idx_sandbox_audit_log_success_created").on(table.success, table.createdAt),
  ]
);

export type SandboxAuditLog = typeof sandboxAuditLog.$inferSelect;
export type NewSandboxAuditLog = typeof sandboxAuditLog.$inferInsert;

// ── Fase 1 telemetry — pattern_memory (migration 0069) ─────────────────────
//
// Per-project (error_fingerprint → fix) index queried by Tier 0 and Tier 1
// in Fase 6. 1024-dim embedding mirrors the existing code_chunks schema so
// operators only tune one HNSW index family. Fase 6 populates this; Fase 1
// just declares the shape.

export const patternMemory = pgTable(
  "pattern_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
    errorFingerprint: text("error_fingerprint").notNull(),
    embedding: vector("embedding"),
    fixStrategy: text("fix_strategy"),
    filesTouched: jsonb("files_touched").notNull().default(sql`'[]'::jsonb`),
    successCount: integer("success_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    confidence: real("confidence"),
    postMergeHealthScore: real("post_merge_health_score"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_pattern_memory_project_fingerprint").on(table.projectId, table.errorFingerprint),
    index("idx_pattern_memory_project_last_used").on(table.projectId, table.lastUsedAt),
  ]
);

export type PatternMemory = typeof patternMemory.$inferSelect;
export type NewPatternMemory = typeof patternMemory.$inferInsert;
