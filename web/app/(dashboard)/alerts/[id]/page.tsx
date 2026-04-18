import type { ReactNode, ElementType } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, alertComments, users, apiKeys, remediationSessions, projectIntegrations, organizations, organizationMembers } from "@/lib/db";
import { eq, and, asc, inArray, desc, or } from "drizzle-orm";
import { ProGate } from "@/components/pro-gate";
import { notFound } from "next/navigation";
import { formatRelativeTime } from "@/lib/utils";
import {
  AlertTriangle, CheckCircle2, Clock, ArrowLeft,
  Github, Zap, GitBranch, Info,
} from "lucide-react";
import Link from "next/link";
import { markAlertResolved, reopenAlert } from "./actions";
import { CommentsSection } from "./comments";
import { AIAnalyzePanel } from "./ai-analyze";
import { RemediationPanel } from "./remediation-panel";
import { CommunityFixBanner } from "./community-fix-banner";
import { PostmortemPanel } from "./postmortem-panel";
import { VercelRollbackPanel } from "./vercel-rollback";
import { FullTraceCard } from "./fulltrace-card";
import { ImpactBadge } from "./impact-badge";
import { FleetVerificationCard } from "./fleet-verification-card";
import { GitContextCard } from "./git-context-card";
import { BreadcrumbsPanel } from "./breadcrumbs-panel";
import { EnvironmentCard, UserContextCard, RequestContextCard } from "./capture-v2-cards";
import { PerformanceBenchmarkCard } from "./performance-benchmark-card";
import { BehavioralDriftCard } from "./behavioral-drift-card";
import { MultiEnvCoverageCard } from "./multi-env-coverage-card";
import { CostImpactCard } from "./cost-impact-card";
import { PreviewPanel } from "./preview-panel";
import { isPreviewFixEnabled } from "@/lib/feature-flags";
import { RolloutCard } from "./rollout-card";
import { SnippetInstaller } from "@/components/snippet-installer";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import type { Metadata } from "next";

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> }
): Promise<Metadata> {
  const { id } = await params;
  const [alert] = await db
    .select({ title: alerts.title, severity: alerts.severity })
    .from(alerts)
    .where(eq(alerts.id, id))
    .limit(1);
  if (!alert) return { title: "Alert not found" };
  return {
    title:       alert.title,
    description: `${alert.severity} alert — ${alert.title}`,
    robots:      { index: false, follow: false },
  };
}

// ── Severity tokens ───────────────────────────────────────────────────────────

const SEV_BAR: Record<string, string> = {
  critical: "bg-inari-accent",
  warning:  "bg-amber-500",
  info:     "bg-blue-500",
};
const SEV_BORDER: Record<string, string> = {
  critical: "border-inari-accent/25",
  warning:  "border-amber-500/25",
  info:     "border-blue-500/25",
};
const SEV_TEXT: Record<string, string> = {
  critical: "text-inari-accent",
  warning:  "text-amber-600 dark:text-amber-400",
  info:     "text-blue-600 dark:text-blue-400",
};
const SEV_DOT: Record<string, string> = {
  critical: "bg-inari-accent",
  warning:  "bg-amber-500",
  info:     "bg-blue-500",
};
const SOURCE_ICON: Record<string, ElementType> = {
  github: Github,
  vercel: Zap,
  sentry: AlertTriangle,
  git:    GitBranch,
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AlertDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Validate UUID shape BEFORE the SELECT — Postgres throws 22P02 on
  // malformed uuid input which surfaces as a 500 (server component crash).
  // A shape mismatch is the same outcome as "not found" from the user's
  // perspective, so collapse to 404 here.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();

  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId) notFound();

  const [alert] = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
  if (!alert) notFound();

  // Authorize the viewer: project owner OR member of the project's
  // organization OR organization owner. The previous check (projects.userId
  // === userId) only worked for personal workspaces — users who joined an
  // org workspace got 404'd on every alert because they didn't own the
  // project directly.
  const [projectRow] = await db
    .select({ project: projects })
    .from(projects)
    .leftJoin(organizations, eq(organizations.id, projects.organizationId))
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, projects.organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(projects.id, alert.projectId),
        or(
          eq(projects.userId, userId),
          eq(organizations.ownerId, userId),
          eq(organizationMembers.userId, userId),
        ),
      ),
    )
    .limit(1);
  if (!projectRow) notFound();
  const project = projectRow.project;

  // Fire-and-forget: mark as read
  if (!alert.isRead) {
    db.update(alerts).set({ isRead: true }).where(eq(alerts.id, alert.id)).catch(() => {});
  }

  // Parallel fetch all independent data
  const [userPlanRows, aiKeyRows, githubRows, sentryRows, remediationRows, commentsRaw] = await Promise.all([
    db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ id: apiKeys.id }).from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), inArray(apiKeys.service, ["claude", "openai"])))
      .limit(1),
    db.select({ id: projectIntegrations.id }).from(projectIntegrations)
      .where(and(
        eq(projectIntegrations.projectId, alert.projectId),
        eq(projectIntegrations.service, "github"),
        eq(projectIntegrations.isActive, true)
      ))
      .limit(1),
    db.select({ id: projectIntegrations.id }).from(projectIntegrations)
      .where(and(
        eq(projectIntegrations.projectId, alert.projectId),
        eq(projectIntegrations.service, "sentry"),
        eq(projectIntegrations.isActive, true)
      ))
      .limit(1),
    db.select().from(remediationSessions)
      .where(eq(remediationSessions.alertId, alert.id))
      .orderBy(desc(remediationSessions.createdAt))
      .limit(1),
    db.select({
      id: alertComments.id,
      body: alertComments.body,
      createdAt: alertComments.createdAt,
      userId: alertComments.userId,
      userName: users.name,
      userEmail: users.email,
    })
      .from(alertComments)
      .innerJoin(users, eq(alertComments.userId, users.id))
      .where(eq(alertComments.alertId, id))
      .orderBy(asc(alertComments.createdAt)),
  ]);

  // All features are available on both Free and Pro tiers (see /pricing).
  // Pro unlocks higher quotas; enforcement happens at the server action level
  // via lib/ai/quota.ts, not here. ProGate is kept as a passthrough in case
  // gating is reintroduced later.
  const isPro            = true;
  const hasAIKey         = true; // Platform AI always available; BYOK is optional
  const hasGitHub        = githubRows.length > 0;
  const hasSentry        = sentryRows.length > 0;
  const latestRemediation = remediationRows[0];

  return (
    <div className="mx-auto max-w-[780px] space-y-5">

      {/* ── Back ───────────────────────────────────────────────────────── */}
      <Link
        href="/alerts"
        className="inline-flex items-center gap-1.5 text-sm text-fg-base transition-colors hover:text-fg-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 rounded-sm"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to alerts
      </Link>

      {/* ── Header card ────────────────────────────────────────────────── */}
      <div className={`overflow-hidden rounded-xl border ${SEV_BORDER[alert.severity] ?? "border-line"} bg-surface`}>
        {/* Top severity bar */}
        <div className={`h-[3px] w-full ${SEV_BAR[alert.severity] ?? "bg-line-medium"}`} aria-hidden="true" />

        <div className="px-6 py-5">
          {/* Badges row */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${SEV_DOT[alert.severity] ?? "bg-line-medium"}`} aria-hidden="true" />
              <span className={`text-xs font-semibold uppercase tracking-widest ${SEV_TEXT[alert.severity] ?? "text-fg-base"}`}>
                {alert.severity}
              </span>
            </div>
            <span className="text-fg-base/40" aria-hidden="true">·</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              alert.isResolved
                ? "bg-surface-dim text-fg-base"
                : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
            }`}>
              {alert.isResolved ? "resolved" : "open"}
            </span>
            {!alert.isRead && (
              <span className="rounded-full bg-inari-accent/10 px-2.5 py-0.5 text-xs font-medium text-inari-accent">
                unread
              </span>
            )}
          </div>

          {/* Title */}
          <h1 className="text-xl font-semibold leading-snug text-fg-strong">{alert.title}</h1>

          {/* Meta */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-base">
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {formatRelativeTime(alert.createdAt)}
            </span>
            <span className="text-fg-base/40" aria-hidden="true">·</span>
            <span className="font-mono">{project.name}</span>
            {alert.sentAt && (
              <>
                <span className="text-fg-base/40" aria-hidden="true">·</span>
                <span>Notified {formatRelativeTime(alert.sentAt)}</span>
              </>
            )}
          </div>

          {/* Source chips */}
          {alert.sourceIntegrations.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {alert.sourceIntegrations.map((src) => {
                const Icon = SOURCE_ICON[src] ?? Info;
                return (
                  <span
                    key={src}
                    className="inline-flex items-center gap-1.5 rounded border border-line-medium bg-surface-dim px-2 py-1 font-mono text-xs text-fg-base"
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {src}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Actions bar */}
        <div className="flex items-center gap-2 border-t border-line bg-surface-inner px-6 py-3">
          {!alert.isResolved ? (
            <form action={markAlertResolved.bind(null, alert.id)}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400 transition-all hover:border-emerald-500/50 hover:bg-emerald-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
              >
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Mark resolved
              </button>
            </form>
          ) : (
            <form action={reopenAlert.bind(null, alert.id)}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3.5 py-1.5 text-sm font-medium text-fg-base transition-all hover:border-line hover:text-fg-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
              >
                Reopen
              </button>
            </form>
          )}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      {alert.body && (
        <Panel title="Details">
          <p className="text-sm leading-relaxed text-fg-base whitespace-pre-wrap">{String(alert.body)}</p>
        </Panel>
      )}

      {/* ── AI Skipped banner (degraded state) ───────────────────────────── */}
      {alert.aiSkippedReason && !alert.aiReasoning && (
        <AiSkippedBanner reason={alert.aiSkippedReason} />
      )}

      {/* ── AI Analysis ────────────────────────────────────────────────── */}
      <ProGate isPro={isPro} feature="AI Analysis">
        <AIAnalyzePanel
          alertId={alert.id}
          hasAIKey={hasAIKey}
          aiReasoning={typeof alert.aiReasoning === "string" ? alert.aiReasoning : null}
        />
      </ProGate>

      {/* ── Business impact badge ──────────────────────────────────────── */}
      {/* Cheap heuristic over title + body + sourceIntegrations + users.   */}
      {/* Renders nothing when score === 0 (low-noise alerts stay calm).    */}
      <ImpactBadge alertId={alert.id} />

      {/* ── FullTrace impact card ──────────────────────────────────────── */}
      {/* Renders only if the alert has a session_id (Capture SDK v0.8+).   */}
      {/* Server component runs its own impact query inline.                */}
      <FullTraceCard alertId={alert.id} />

      {/* ── Fleet Verification card (VAR Gate 12) ────────────────────────── */}
      {/* Renders only when a remediation exists. Client-polls the worker's  */}
      {/* fleet-verification job for live progress + final gauge.            */}
      <FleetVerificationCard
        alertId={alert.id}
        remediationId={latestRemediation?.id ?? null}
        remediationReady={
          !!latestRemediation && (
            latestRemediation.status === "completed" ||
            latestRemediation.status === "proposing" ||
            latestRemediation.status === "merging" ||
            latestRemediation.status === "approved"
          )
        }
      />

      {/* ── Performance Benchmark card (VAR Gate 17) ─────────────────────── */}
      {/* Reuses substrate event timings from Gate 12 — cheap, no clones.    */}
      <PerformanceBenchmarkCard
        alertId={alert.id}
        remediationId={latestRemediation?.id ?? null}
        remediationReady={
          !!latestRemediation && (
            latestRemediation.status === "completed" ||
            latestRemediation.status === "proposing" ||
            latestRemediation.status === "merging" ||
            latestRemediation.status === "approved"
          )
        }
      />

      {/* ── Behavioral Drift card (VAR Gate 13) ──────────────────────────── */}
      {/* Compares fix replay against 7d baseline of healthy recordings.    */}
      {/* Yellow light: improvements are surfaced separately, never fail.   */}
      <BehavioralDriftCard
        alertId={alert.id}
        remediationId={latestRemediation?.id ?? null}
        remediationReady={
          !!latestRemediation && (
            latestRemediation.status === "completed" ||
            latestRemediation.status === "proposing" ||
            latestRemediation.status === "merging" ||
            latestRemediation.status === "approved"
          )
        }
      />

      {/* ── Multi-Environment Coverage card (VAR Gate 16) ─────────────── */}
      {/* Compares fleet replay env distribution vs project Node runtime. */}
      {/* Fails when a Node major with >20% traffic wasn't exercised.    */}
      <MultiEnvCoverageCard
        alertId={alert.id}
        remediationId={latestRemediation?.id ?? null}
        remediationReady={
          !!latestRemediation && (
            latestRemediation.status === "completed" ||
            latestRemediation.status === "proposing" ||
            latestRemediation.status === "merging" ||
            latestRemediation.status === "approved"
          )
        }
      />

      {/* ── Cost Impact card (VAR Gate 14) ─────────────────────────────── */}
      {/* Aggregates AI spend from ai_usage_logs for this remediation.   */}
      {/* Gate fails when total cost exceeds the configured budget.      */}
      <CostImpactCard
        alertId={alert.id}
        remediationId={latestRemediation?.id ?? null}
        remediationReady={
          !!latestRemediation && (
            latestRemediation.status === "completed" ||
            latestRemediation.status === "proposing" ||
            latestRemediation.status === "merging" ||
            latestRemediation.status === "approved"
          )
        }
      />

      {/* ── Progressive Rollout (VAR Q2 Week 12) ───────────────────────── */}
      {/* Stages fix through 1% → 10% → 50% → 100% with manual advance   */}
      {/* + rollback controls. Stage history + per-stage metrics audit.  */}
      <RolloutCard
        alertId={alert.id}
        remediationId={latestRemediation?.id ?? null}
        remediationReady={
          !!latestRemediation && (
            latestRemediation.status === "completed" ||
            latestRemediation.status === "proposing" ||
            latestRemediation.status === "merging" ||
            latestRemediation.status === "approved"
          )
        }
      />

      {/* ── Vercel rollback ────────────────────────────────────────────── */}
      {isPro && alert.sourceIntegrations.includes("vercel") && !alert.isResolved && (
        <VercelRollbackPanel alertId={alert.id} isResolved={alert.isResolved} />
      )}

      {/* ── Community Fix ──────────────────────────────────────────────── */}
      {alert.fingerprint && !alert.isResolved && (
        <CommunityFixBanner alertId={alert.id} fingerprint={alert.fingerprint} />
      )}

      {/* ── EAP Attestation deep link (VAR Q3 Phase 2) ────────────────── */}
      {/* Renders only when the remediation has produced a signed EAP    */}
      {/* receipt. Points to the public audit page at /attestation/:id.  */}
      {latestRemediation?.eapReceiptId && (
        <Link
          href={`/attestation/${latestRemediation.eapReceiptId}`}
          className="group flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2.5 text-xs text-fg-base/80 hover:border-inari-accent/40 hover:text-fg-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5 shrink-0 text-emerald-500"
            aria-hidden="true"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-fg-strong">
              EAP attestation available
            </div>
            <div className="text-[11px] text-fg-base/60 font-mono truncate">
              {latestRemediation.eapReceiptId.slice(0, 16)}… · Merkle-rooted, Ed25519-signed
            </div>
          </div>
          <span className="text-[10px] uppercase tracking-wider text-fg-base/50 group-hover:text-inari-accent">
            view audit →
          </span>
        </Link>
      )}

      {/* ── Preview Fix — two-tier visual preview of the autonomous fix ────── */}
      {latestRemediation?.status === "completed" &&
        latestRemediation.mergedCommitSha &&
        isPreviewFixEnabled(project.organizationId) && (
          <PreviewPanel
            alertId={alert.id}
            remediationSessionId={latestRemediation.id}
            eapReceiptId={latestRemediation.eapReceiptId}
            projectName={project.name}
          />
        )}

      {/* ── AI Remediation (not for agent/kernel alerts — those need operational response, not code fixes) */}
      {!alert.sourceIntegrations.includes("agent") && <ProGate isPro={isPro} feature="AI Remediation">
        <RemediationPanel
          alertId={alert.id}
          hasAIKey={hasAIKey}
          hasGitHub={hasGitHub}
          isVercelOnly={alert.sourceIntegrations.includes("vercel") && !hasSentry}
          existingSession={latestRemediation ? {
            id:       latestRemediation.id,
            status:   latestRemediation.status,
            steps:    latestRemediation.steps,
            prUrl:    latestRemediation.prUrl,
            prNumber: latestRemediation.prNumber,
            error:    latestRemediation.error,
          } : null}
        />
      </ProGate>}

      {/* ── Post-mortem ─────────────────────────────────────────────────── */}
      <ProGate isPro={isPro} feature="Post-mortem">
        <PostmortemPanel
          alertId={alert.id}
          postmortem={alert.postmortem}
          isResolved={alert.isResolved}
          hasAIKey={hasAIKey}
        />
      </ProGate>

      {/* ── Git Context (Capture SDK v2) ─────────────────────────────────── */}
      {/* Pretty-print the commit SHA + branch that shipped when the error     */}
      {/* fired. Renders nothing when the payload is missing/malformed.         */}
      {alert.correlationData
        ? <GitContextCard
            data={(alert.correlationData as Record<string, unknown>).git}
            repo={latestRemediation?.repo ?? null}
          />
        : null}

      {/* ── Breadcrumbs (Capture SDK v2) ─────────────────────────────────── */}
      {/* Collapsible timeline of console + fetch events in the ~30s before    */}
      {/* the crash. Color-coded by level.                                      */}
      {alert.correlationData
        ? <BreadcrumbsPanel data={(alert.correlationData as Record<string, unknown>).breadcrumbs} />
        : null}

      {/* ── Environment / User / Request (Capture SDK v2 — Week 3) ───────── */}
      {/* Each card hides itself when its slice of correlationData is missing. */}
      {alert.correlationData
        ? <EnvironmentCard data={(alert.correlationData as Record<string, unknown>).env} />
        : null}
      {alert.correlationData
        ? <UserContextCard data={(alert.correlationData as Record<string, unknown>).user} />
        : null}
      {alert.correlationData
        ? <RequestContextCard data={(alert.correlationData as Record<string, unknown>).request} />
        : null}

      {/* ── Correlation (raw JSON dump for anything not covered above) ──── */}
      {alert.correlationData
        ? <CorrelationCard data={alert.correlationData as Record<string, unknown>} />
        : null}

      {/* ── Metadata ────────────────────────────────────────────────────── */}
      <Panel title="Metadata">
        <dl className="divide-y divide-line-subtle">
          {[
            { label: "Alert ID",  value: alert.id },
            { label: "Project",   value: `${project.name} (${project.slug})` },
            { label: "Created",   value: alert.createdAt.toISOString() },
            { label: "Severity",  value: alert.severity },
            { label: "Status",    value: alert.isResolved ? "Resolved" : "Open" },
            { label: "Read",      value: alert.isRead ? "Yes" : "No" },
          ].map(({ label, value }) => (
            <div key={label} className="grid grid-cols-[130px_1fr] gap-4 py-2.5">
              <dt className="text-xs text-fg-base/70">{label}</dt>
              <dd className="font-mono text-xs text-fg-base break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      {/* ── Session replay setup (collapsed by default) ─────────────────── */}
      {isReplayV2Enabled(project.organizationId) && (
        <SnippetInstaller
          projectId={project.id}
          projectName={project.name}
          defaultCollapsed
        />
      )}

      {/* ── Comments ────────────────────────────────────────────────────── */}
      <ProGate isPro={isPro} feature="Comments">
        <CommentsSection
          alertId={id}
          comments={commentsRaw}
          currentUserId={userId}
        />
      </ProGate>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-fg-base/70">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function AiSkippedBanner({ reason }: { reason: string }) {
  const messages: Record<string, { title: string; body: string }> = {
    platform_budget: {
      title: "AI analysis paused",
      body: "The free-tier AI budget for today has been reached. Analysis will resume automatically at midnight UTC. Add your own AI key in Settings to bypass the limit.",
    },
    quota: {
      title: "Monthly AI quota reached",
      body: "You've used your monthly auto-analysis quota. Resets on the 1st of next month.",
    },
    no_key: {
      title: "No AI key configured",
      body: "Add an AI key in Settings to enable automatic analysis on new alerts.",
    },
  };
  const m = messages[reason] ?? { title: "AI analysis skipped", body: `Reason: ${reason}` };
  return (
    <section
      role="status"
      className="overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4"
    >
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">{m.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-fg-base">{m.body}</p>
        </div>
      </div>
    </section>
  );
}

function CorrelationCard({ data }: { data: Record<string, unknown> }) {
  return (
    <section className="overflow-hidden rounded-xl border border-violet-500/25 bg-violet-500/[0.04]">
      <div className="flex items-center gap-2 border-b border-violet-500/20 px-5 py-3">
        <span className="h-2 w-2 rounded-full bg-violet-500" aria-hidden="true" />
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-violet-700 dark:text-violet-300">
          Correlated incident
        </h2>
        <span className="ml-auto rounded-full border border-violet-500/30 px-2 py-0.5 text-[10px] font-mono text-violet-700 dark:text-violet-400">
          {String(data.correlationId ?? "")}
        </span>
      </div>
      <div className="px-5 py-4">
        <p className="text-sm leading-relaxed text-fg-base">{String(data.summary ?? "")}</p>
        {data.groupSize ? (
          <p className="mt-2 text-xs text-fg-base/70">
            Part of a group of {String(data.groupSize)} related alerts detected in the same polling cycle.
          </p>
        ) : null}
      </div>
    </section>
  );
}
