import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, alertComments, users, apiKeys, remediationSessions, projectIntegrations } from "@/lib/db";
import { eq, and, asc, inArray, desc } from "drizzle-orm";
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
import { PostmortemPanel } from "./postmortem-panel";
import { VercelRollbackPanel } from "./vercel-rollback";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Alert detail" };

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-inari-accent",
  warning:  "bg-amber-400",
  info:     "bg-blue-400",
};
const SEVERITY_BORDER: Record<string, string> = {
  critical: "border-inari-accent/30",
  warning:  "border-amber-400/30",
  info:     "border-blue-400/30",
};
const SEVERITY_TEXT: Record<string, string> = {
  critical: "text-inari-accent",
  warning:  "text-amber-400",
  info:     "text-blue-400",
};
const SOURCE_ICON: Record<string, React.ElementType> = {
  github: Github,
  vercel: Zap,
  sentry: AlertTriangle,
  git:    GitBranch,
};

export default async function AlertDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId) notFound();

  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, id))
    .limit(1);

  if (!alert) notFound();

  // Verify ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, alert.projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) notFound();

  // Mark as read automatically when viewed
  if (!alert.isRead) {
    await db.update(alerts).set({ isRead: true }).where(eq(alerts.id, alert.id));
  }

  // Check if user has an AI key
  const hasAIKey = (
    await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), inArray(apiKeys.service, ["claude", "openai"])))
      .limit(1)
  ).length > 0;

  // Check if project has GitHub integration
  const hasGitHub = (
    await db
      .select({ id: projectIntegrations.id })
      .from(projectIntegrations)
      .where(and(
        eq(projectIntegrations.projectId, alert.projectId),
        eq(projectIntegrations.service, "github"),
        eq(projectIntegrations.isActive, true)
      ))
      .limit(1)
  ).length > 0;

  // Get latest remediation session for this alert
  const [latestRemediation] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.alertId, alert.id))
    .orderBy(desc(remediationSessions.createdAt))
    .limit(1);

  // Fetch comments with user info
  const commentsRaw = await db
    .select({
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
    .orderBy(asc(alertComments.createdAt));

  return (
    <div className="max-w-[780px] space-y-6">

      {/* Back */}
      <Link
        href="/alerts"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to alerts
      </Link>

      {/* Header card */}
      <div className={`rounded-xl border ${SEVERITY_BORDER[alert.severity] ?? "border-[#1a1a1a]"} bg-[#0a0a0a] overflow-hidden`}>

        {/* Severity bar */}
        <div className={`h-[3px] w-full ${
          alert.severity === "critical" ? "bg-inari-accent" :
          alert.severity === "warning"  ? "bg-amber-400" :
          "bg-blue-400"
        }`} />

        <div className="px-6 py-5">
          {/* Severity + status badges */}
          <div className="flex items-center gap-2 mb-3">
            <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[alert.severity] ?? "bg-zinc-600"}`} />
            <span className={`text-xs font-medium uppercase tracking-wider ${SEVERITY_TEXT[alert.severity] ?? "text-zinc-500"}`}>
              {alert.severity}
            </span>
            <span className="text-zinc-800">·</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              alert.isResolved
                ? "bg-zinc-800/60 text-zinc-500"
                : "bg-amber-400/10 text-amber-500"
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
          <h1 className="text-xl font-semibold text-white leading-snug">{alert.title}</h1>

          {/* Meta row */}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {formatRelativeTime(alert.createdAt)}
            </span>
            <span className="text-zinc-700">·</span>
            <span className="font-mono">{project.name}</span>
            {alert.sentAt && (
              <>
                <span className="text-zinc-700">·</span>
                <span>Notified {formatRelativeTime(alert.sentAt)}</span>
              </>
            )}
          </div>

          {/* Source integrations */}
          {alert.sourceIntegrations.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {alert.sourceIntegrations.map((src) => {
                const Icon = SOURCE_ICON[src] ?? Info;
                return (
                  <span
                    key={src}
                    className="inline-flex items-center gap-1.5 rounded border border-[#222] bg-[#111] px-2 py-1 font-mono text-xs text-zinc-500"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {src}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Actions bar */}
        <div className="flex items-center gap-2 border-t border-[#1a1a1a] bg-[#080808] px-6 py-3">
          {!alert.isResolved ? (
            <form action={markAlertResolved.bind(null, alert.id)}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg border border-green-900/40 bg-green-950/20 px-3.5 py-1.5 text-sm font-medium text-green-400 hover:bg-green-950/40 hover:border-green-800/50 transition-all"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Mark resolved
              </button>
            </form>
          ) : (
            <form action={reopenAlert.bind(null, alert.id)}>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#222] bg-transparent px-3.5 py-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-all"
              >
                Reopen
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Body */}
      {alert.body ? (
        <section className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
          <div className="border-b border-[#1a1a1a] px-5 py-3">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Details</span>
          </div>
          <div className="px-5 py-4">
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{String(alert.body)}</p>
          </div>
        </section>
      ) : null}

      {/* AI Analysis panel */}
      <AIAnalyzePanel
        alertId={alert.id}
        hasAIKey={hasAIKey}
        aiReasoning={alert.aiReasoning}
      />

      {/* Vercel rollback — shown for Vercel deploy failures */}
      {alert.sourceIntegrations.includes("vercel") && !alert.isResolved && (
        <VercelRollbackPanel alertId={alert.id} isResolved={alert.isResolved} />
      )}

      {/* AI Remediation — fix with AI */}
      <RemediationPanel
        alertId={alert.id}
        hasAIKey={hasAIKey}
        hasGitHub={hasGitHub}
        existingSession={latestRemediation ? {
          id: latestRemediation.id,
          status: latestRemediation.status,
          steps: latestRemediation.steps,
          prUrl: latestRemediation.prUrl,
          prNumber: latestRemediation.prNumber,
          error: latestRemediation.error,
        } : null}
      />

      {/* Post-mortem — shown for resolved alerts */}
      <PostmortemPanel
        alertId={alert.id}
        postmortem={alert.postmortem}
        isResolved={alert.isResolved}
        hasAIKey={hasAIKey}
      />

      {/* Correlation badge — shown when this alert is part of a correlated group */}
      {alert.correlationData
        ? <CorrelationCard data={alert.correlationData as Record<string, unknown>} />
        : null}

      {/* Meta table */}
      <section className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
        <div className="border-b border-[#1a1a1a] px-5 py-3">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Metadata</span>
        </div>
        <div className="divide-y divide-[#131313]">
          {[
            { label: "Alert ID",   value: alert.id },
            { label: "Project",    value: `${project.name} (${project.slug})` },
            { label: "Created",    value: alert.createdAt.toISOString() },
            { label: "Severity",   value: alert.severity },
            { label: "Status",     value: alert.isResolved ? "Resolved" : "Open" },
            { label: "Read",       value: alert.isRead ? "Yes" : "No" },
          ].map(({ label, value }) => (
            <div key={label} className="grid grid-cols-[140px_1fr] gap-4 px-5 py-3">
              <span className="text-sm text-zinc-500">{label}</span>
              <span className="font-mono text-sm text-zinc-400 break-all">{value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Comments */}
      <CommentsSection
        alertId={id}
        comments={commentsRaw}
        currentUserId={userId}
      />

    </div>
  );
}

function CorrelationCard({ data }: { data: Record<string, unknown> }) {
  return (
    <section className="rounded-xl border border-violet-900/30 bg-violet-950/10 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-violet-900/20 px-5 py-3">
        <span className="h-2 w-2 rounded-full bg-violet-400" />
        <span className="text-xs font-medium uppercase tracking-wider text-violet-400">
          Correlated incident
        </span>
        <span className="ml-auto rounded-full border border-violet-900/30 px-2 py-0.5 text-[10px] font-mono text-violet-600">
          {String(data.correlationId ?? "")}
        </span>
      </div>
      <div className="px-5 py-4">
        <p className="text-sm text-zinc-400 leading-relaxed">{String(data.summary ?? "")}</p>
        {data.groupSize ? (
          <p className="mt-2 text-xs text-zinc-600">
            Part of a group of {String(data.groupSize)} related alerts detected in the same polling cycle.
          </p>
        ) : null}
      </div>
    </section>
  );
}
