import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users, notificationChannels, apiKeys, outgoingWebhooks, auditLogs, slackInstallations, slackChannelMappings, projects, mcpTokens } from "@/lib/db";
import { sql } from "drizzle-orm";
import { eq, desc } from "drizzle-orm";
import { formatRelativeTime } from "@/lib/utils";
import { MessageSquare, Mail, Bell, Key, Monitor, Hash } from "lucide-react";
import { GenerateDesktopTokenButton } from "./generate-token-button";
import { McpTokenSection } from "./mcp-tokens";
import { McpDashboard } from "./mcp-dashboard";
import { ConnectTelegramButton } from "./connect-telegram";
import { ConnectEmailButton } from "./connect-email";
import { ConnectSlackButton, SlackChannelRow } from "./connect-slack";
import { ChannelToggle, ChannelDeleteButton, SeverityFilter } from "./channel-actions";
import { PushNotificationsButton } from "./push-notifications";
import { VerifyEmailBanner } from "./verify-email-banner";
import { UpgradeButton } from "./upgrade-button";
import { WebhookSection } from "./webhook-section";
import { AuditLogSection } from "./audit-log-section";
import { TwoFactorSection } from "./two-factor";
import { AIKeySection } from "./ai-key";
import { ProGate } from "@/components/pro-gate";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings" };

const PLAN_BADGE: Record<string, { label: string; color: string }> = {
  free: { label: "100% Free", color: "text-inari-accent border-inari-accent/20 bg-inari-accent-dim" },
  pro:  { label: "100% Free", color: "text-inari-accent border-inari-accent/20 bg-inari-accent-dim" },
};

const CHANNEL_ICON: Record<string, React.ElementType> = {
  telegram: MessageSquare,
  whatsapp: MessageSquare,
  email:    Mail,
  slack:    Hash,
};

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  const [userRows, channels, keys, webhooks, auditEntries, slackRows, userProjects, mcpTokenRows] = userId
    ? await Promise.all([
        db.select().from(users).where(eq(users.id, userId)).limit(1),
        db.select().from(notificationChannels).where(eq(notificationChannels.userId, userId)),
        db.select().from(apiKeys).where(eq(apiKeys.userId, userId)),
        db.select().from(outgoingWebhooks).where(eq(outgoingWebhooks.userId, userId)),
        db.select().from(auditLogs).where(eq(auditLogs.userId, userId)).orderBy(desc(auditLogs.createdAt)).limit(30),
        db.select().from(slackInstallations).where(eq(slackInstallations.userId, userId)).limit(1),
        db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.userId, userId)),
        db.select().from(mcpTokens).where(eq(mcpTokens.userId, userId)).orderBy(desc(mcpTokens.createdAt)),
      ])
    : [[], [], [], [], [], [], [], []];

  const user       = userRows[0];
  const isPro      = user?.plan === "pro";
  const slackInstall = slackRows[0] ?? null;
  const slackMappings = slackInstall
    ? await db.select({
        projectId: slackChannelMappings.projectId,
        projectName: projects.name,
        channelId: slackChannelMappings.channelId,
        channelName: slackChannelMappings.channelName,
      })
        .from(slackChannelMappings)
        .innerJoin(projects, eq(slackChannelMappings.projectId, projects.id))
        .where(eq(slackChannelMappings.installationId, slackInstall.id))
    : [];
  const desktopKey = keys.find((k) => k.service === "desktop");
  const AI_PRIORITY: Record<string, number> = { claude: 0, openai: 1, grok: 2, deepseek: 3, gemini: 4 };
  const AI_SERVICES = Object.keys(AI_PRIORITY);
  const aiKeyRow = keys
    .filter((k) => AI_SERVICES.includes(k.service))
    .sort((a, b) => (AI_PRIORITY[a.service] ?? 99) - (AI_PRIORITY[b.service] ?? 99))[0] ?? null;
  const plan       = PLAN_BADGE[user?.plan ?? "free"] ?? PLAN_BADGE.free;

  // MCP usage stats from audit logs (last 30 days)
  const mcpStatsRaw = userId ? await db.execute(sql`
    SELECT
      count(*)::int AS total_calls,
      count(*) FILTER (WHERE (metadata->>'ok')::boolean = false)::int AS total_errors,
      coalesce(avg((metadata->>'latencyMs')::int), 0)::int AS avg_latency,
      coalesce(percentile_cont(0.99) WITHIN GROUP (ORDER BY (metadata->>'latencyMs')::int), 0)::int AS p99_latency
    FROM audit_logs
    WHERE user_id = ${userId} AND action LIKE 'mcp.%' AND created_at > now() - interval '30 days'
  `) : null;

  const mcpTopToolsRaw = userId ? await db.execute(sql`
    SELECT action AS tool, count(*)::int AS count
    FROM audit_logs
    WHERE user_id = ${userId} AND action LIKE 'mcp.%' AND created_at > now() - interval '30 days'
    GROUP BY action ORDER BY count DESC LIMIT 5
  `) : null;

  const mcpByDayRaw = userId ? await db.execute(sql`
    SELECT to_char(created_at, 'YYYY-MM-DD') AS date, count(*)::int AS count
    FROM audit_logs
    WHERE user_id = ${userId} AND action LIKE 'mcp.%' AND created_at > now() - interval '7 days'
    GROUP BY date ORDER BY date
  `) : null;

  const s = mcpStatsRaw?.rows?.[0] as Record<string, number> | undefined;
  const mcpStats = {
    totalCalls: s?.total_calls ?? 0,
    totalErrors: s?.total_errors ?? 0,
    avgLatencyMs: s?.avg_latency ?? 0,
    p99LatencyMs: s?.p99_latency ?? 0,
    topTools: ((mcpTopToolsRaw?.rows ?? []) as { tool: string; count: number }[]),
    callsByDay: ((mcpByDayRaw?.rows ?? []) as { date: string; count: number }[]),
  };

  return (
    <div className="mx-auto max-w-[680px] space-y-8">

      <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Settings</h1>

      <VerifyEmailBanner
        hasPassword={!!user?.passwordHash}
        emailVerifiedAt={user?.emailVerifiedAt ?? null}
      />

      {/* ── Account ─────────────────────────────────────────────────────── */}
      <Section title="Account">
        <Row label="Name">
          <span className="text-sm text-fg-base">{user?.name ?? "—"}</span>
        </Row>
        <Row label="Email">
          <span className="text-sm text-fg-base">{user?.email ?? session?.user?.email ?? "—"}</span>
        </Row>
        <Row label="Plan">
          <div className="flex items-center gap-3">
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${plan.color}`}>
              {plan.label}
            </span>
          </div>
        </Row>
        <Row label="Member since">
          <span className="font-mono text-sm text-zinc-500">
            {user?.createdAt
              ? new Date(user.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
              : "—"}
          </span>
        </Row>
      </Section>

      {/* ── Notifications ────────────────────────────────────────────────── */}
      <ProGate isPro={isPro} feature="Notification channels">
      <Section title="Notification channels">
        {channels.length === 0 ? (
          <div className="py-4 space-y-3">
            <div className="text-center">
              <p className="text-sm text-zinc-500">No channels connected.</p>
              <p className="mt-1 text-sm text-zinc-600">
                Connect a channel to get notified when InariWatch detects issues.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ConnectTelegramButton />
              <ConnectEmailButton />
              {!slackInstall && <ConnectSlackButton projects={userProjects} />}
            </div>
            <PushNotificationsButton />
          </div>
        ) : (
          <div className="space-y-3 py-1">
            <div className="divide-y divide-line-subtle">
              {slackInstall && (
                <SlackChannelRow
                  installation={{ id: slackInstall.id, teamName: slackInstall.teamName, createdAt: slackInstall.createdAt?.toISOString() ?? "" }}
                  channelMappings={slackMappings}
                  projects={userProjects}
                />
              )}
              {channels.map((ch) => {
                const chType = ch.type as string;
                const Icon   = CHANNEL_ICON[chType] ?? Bell;
                const config = ch.config as Record<string, string>;
                return (
                  <div key={ch.id} className="flex items-center gap-3 py-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-surface-dim text-zinc-500">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm capitalize text-fg-base">
                        {chType === "push" ? "Push" : chType}
                        {config.bot_name  && <span className="ml-1.5 text-xs text-zinc-600">@{config.bot_name}</span>}
                        {config.email     && <span className="ml-1.5 text-xs text-zinc-600">{config.email}</span>}
                        {config.webhook_url && (
                          <span className="ml-1.5 text-xs text-zinc-600">
                            {config.webhook_url.replace(/^https:\/\/hooks\.slack\.com\/services\//, "").slice(0, 12)}…
                          </span>
                        )}
                        {chType === "push" && <span className="ml-1.5 text-xs text-zinc-600">Browser</span>}
                      </p>
                      <p className="text-xs text-zinc-700">
                        {ch.verifiedAt ? `Verified ${formatRelativeTime(ch.verifiedAt)}` : "Not verified"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <SeverityFilter channelId={ch.id} minSeverity={ch.minSeverity} />
                      <ChannelToggle channelId={ch.id} isActive={ch.isActive} />
                      <ChannelDeleteButton channelId={ch.id} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!channels.some((ch) => ch.type === "telegram")          && <ConnectTelegramButton />}
              {!channels.some((ch) => ch.type === "email")             && <ConnectEmailButton />}
              {!slackInstall && <ConnectSlackButton projects={userProjects} />}
              {!channels.some((ch) => (ch.type as string) === "push")  && <PushNotificationsButton />}
            </div>
          </div>
        )}
      </Section>
      </ProGate>

      {/* ── MCP Access Tokens ─────────────────────────────────────────────── */}
      <Section title="MCP">
        <McpTokenSection
          tokens={mcpTokenRows.map((t) => ({
            id: t.id,
            name: t.name,
            tokenPreview: `inari_${"•".repeat(24)}`,
            lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
            createdAt: t.createdAt.toISOString(),
          }))}
        />
      </Section>

      {/* ── MCP Usage Dashboard ──────────────────────────────────────────── */}
      {(mcpTokenRows.length > 0 || mcpStats.totalCalls > 0) && (
        <Section title="MCP usage">
          <McpDashboard stats={mcpStats} />
        </Section>
      )}

      {/* ── API Keys ─────────────────────────────────────────────────────── */}
      <Section title="API keys">
        {keys.length === 0 ? (
          <div className="py-4 text-center">
            <p className="text-sm text-zinc-500">No API keys stored.</p>
            <p className="mt-1 text-sm text-zinc-600">Keys are added via the InariWatch CLI.</p>
          </div>
        ) : (
          <div className="divide-y divide-line-subtle">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-surface-dim text-zinc-500">
                  <Key className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm capitalize text-fg-base">{k.service}</p>
                  <p className="font-mono text-xs text-zinc-700">••••••••••••••••••••</p>
                </div>
                <p className="font-mono text-xs text-zinc-700">{formatRelativeTime(k.createdAt)}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Desktop app ──────────────────────────────────────────────────── */}
      <ProGate isPro={isPro} feature="Desktop app">
      <Section title="Desktop app">
        <div className="py-3 space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-surface-dim text-zinc-500 mt-0.5">
              <Monitor className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-fg-base">Desktop token</p>
              <p className="mt-0.5 text-sm text-zinc-500">
                Used by the InariWatch desktop app to poll for alerts in the background.
              </p>
              {desktopKey ? (
                <p className="mt-1.5 font-mono text-xs text-zinc-600 tracking-wide">
                  rdr_{"•".repeat(20)}{" "}
                  <span className="text-zinc-700">— generated {formatRelativeTime(desktopKey.createdAt)}</span>
                </p>
              ) : (
                <p className="mt-1.5 text-sm text-zinc-700">No token yet.</p>
              )}
            </div>
          </div>

          <GenerateDesktopTokenButton />

          {desktopKey && (
            <div className="rounded-lg border border-line bg-surface-inner px-4 py-3 space-y-1">
              <p className="text-xs text-zinc-600">Add to <span className="font-mono">~/.config/inari/desktop.toml</span></p>
              <p className="font-mono text-sm text-zinc-600">api_url = <span className="text-zinc-400">"https://inariwatch.com"</span></p>
              <p className="font-mono text-sm text-zinc-600">api_token = <span className="text-zinc-400">"your-token"</span></p>
            </div>
          )}
        </div>
      </Section>
      </ProGate>

      {/* ── AI analysis ──────────────────────────────────────────────────── */}
      <ProGate isPro={isPro} feature="AI analysis">
      <Section title="AI analysis">
        <AIKeySection
          hasKey={!!aiKeyRow}
          provider={aiKeyRow?.service ?? null}
          savedProviders={keys.filter((k) => AI_SERVICES.includes(k.service)).map((k) => k.service)}
          modelPrefs={user?.aiModels as Record<string, string> | null}
        />
      </Section>
      </ProGate>

      {/* ── Security ─────────────────────────────────────────────────────── */}
      <Section title="Security">
        <TwoFactorSection enabled={user?.twoFactorEnabled ?? false} />
      </Section>

      {/* ── Outgoing webhooks ────────────────────────────────────────────── */}
      <ProGate isPro={isPro} feature="Outgoing webhooks">
      <Section title="Outgoing webhooks">
        <WebhookSection webhooks={webhooks} />
      </Section>
      </ProGate>

      {/* ── Audit log ────────────────────────────────────────────────────── */}
      <ProGate isPro={isPro} feature="Audit log">
      <Section title="Audit log">
        <AuditLogSection entries={auditEntries} />
      </Section>
      </ProGate>

      {/* ── Danger zone ──────────────────────────────────────────────────── */}
      <Section title="Danger zone">
        <div className="flex items-center justify-between rounded-lg border border-red-950/40 bg-red-950/10 px-4 py-3.5">
          <div>
            <p className="text-sm font-medium text-fg-base">Delete account</p>
            <p className="mt-0.5 text-sm text-zinc-500">
              Permanently remove your account and all associated data.
            </p>
          </div>
          <button
            disabled
            className="cursor-not-allowed rounded-lg border border-red-900/20 px-3 py-1.5 text-sm font-medium text-red-900"
            title="Contact support to delete your account"
          >
            Delete
          </button>
        </div>
      </Section>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-widest text-zinc-600">{title}</h2>
      <div className="overflow-hidden rounded-xl border border-line bg-surface px-5 divide-y divide-line-subtle">
        {children}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <span className="w-28 shrink-0 text-sm text-zinc-500">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}
