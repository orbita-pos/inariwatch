import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, testGenerationSessions, getWorkspaceProjectIds } from "@/lib/db";
import { getActiveOrgId } from "@/lib/workspace";
import { and, desc, eq, inArray } from "drizzle-orm";
import { formatRelativeTime } from "@/lib/utils";
import Link from "next/link";
import type { Metadata } from "next";
import { CheckCircle2, XCircle, Clock, FileCode } from "lucide-react";

const PAGE_SIZE = 50;

export const metadata: Metadata = {
  title: "Test Generation · Inari Guard",
};

// ── Status tokens ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  pending:    "Pending",
  exploring:  "Exploring",
  planning:   "Planning",
  writing:    "Writing",
  verifying:  "Verifying",
  reviewing:  "Reviewing",
  ready:      "Ready",
  delivered:  "Delivered",
  failed:     "Failed",
  cancelled:  "Cancelled",
};

const STATUS_COLOR: Record<string, string> = {
  ready:     "text-emerald-600 dark:text-emerald-400",
  delivered: "text-emerald-600 dark:text-emerald-400",
  failed:    "text-red-600 dark:text-red-400",
  cancelled: "text-zinc-500",
};

function statusIcon(status: string) {
  if (status === "ready" || status === "delivered") return <CheckCircle2 size={14} aria-hidden />;
  if (status === "failed" || status === "cancelled") return <XCircle size={14} aria-hidden />;
  return <Clock size={14} aria-hidden />;
}

function fmtCost(cents: number | null | undefined): string {
  if (cents == null || cents === 0) return "—";
  return `$${(cents / 100).toFixed(3)}`;
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function TestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;

  if (!userId) {
    return (
      <div className="p-8">
        <p className="text-sm text-zinc-600">Please sign in to view test generations.</p>
      </div>
    );
  }

  const activeOrgId = await getActiveOrgId();
  const projectIds = await getWorkspaceProjectIds(userId, activeOrgId);

  // ── Empty state — no projects yet
  if (projectIds.length === 0) {
    return (
      <div className="p-8 max-w-3xl">
        <h1 className="text-2xl font-light tracking-tight mb-2">Test Generation</h1>
        <p className="text-sm text-zinc-600 mb-6">
          AI-generated tests for your code. Connect a project first to start.
        </p>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-6 text-center">
          <FileCode size={28} className="mx-auto mb-3 text-zinc-400" aria-hidden />
          <p className="text-sm text-zinc-600 mb-4">No projects connected yet.</p>
          <Link
            href="/integrations"
            className="text-sm text-inari-accent hover:underline"
          >
            Connect a project →
          </Link>
        </div>
      </div>
    );
  }

  // ── Pagination
  const page = Math.max(1, Number(params.page ?? 1));
  const offset = (page - 1) * PAGE_SIZE;

  // ── Project filter
  const projectFilter = (Array.isArray(params.project) ? params.project[0] : params.project) ?? "all";
  const filteredIds =
    projectFilter !== "all" && projectIds.includes(projectFilter)
      ? [projectFilter]
      : projectIds;

  const whereClause = and(
    inArray(testGenerationSessions.projectId, filteredIds),
    eq(testGenerationSessions.userId, userId),
  );

  // Fetch rows + project names in parallel
  const [rows, projectRows] = await Promise.all([
    db
      .select({
        id: testGenerationSessions.id,
        projectId: testGenerationSessions.projectId,
        sourceKind: testGenerationSessions.sourceKind,
        sourceTarget: testGenerationSessions.sourceTarget,
        status: testGenerationSessions.status,
        frameworkDetected: testGenerationSessions.frameworkDetected,
        costCents: testGenerationSessions.costCents,
        durationMs: testGenerationSessions.durationMs,
        error: testGenerationSessions.error,
        alertId: testGenerationSessions.alertId,
        createdAt: testGenerationSessions.createdAt,
      })
      .from(testGenerationSessions)
      .where(whereClause)
      .orderBy(desc(testGenerationSessions.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, projectIds)),
  ]);

  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));

  // ── Render
  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-light tracking-tight">Test Generation</h1>
          <p className="text-sm text-zinc-600 mt-1">
            AI-generated tests. Three-pass pipeline (Qwen3-Coder-Next →
            Qwen3-Coder-480B → Qwen3-235B-A22B) with deterministic quality
            gates.
          </p>
        </div>
        <div className="text-xs text-zinc-500">
          {rows.length} session{rows.length === 1 ? "" : "s"}
          {page > 1 ? ` · page ${page}` : ""}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center">
          <FileCode size={32} className="mx-auto mb-4 text-zinc-400" aria-hidden />
          <p className="text-sm text-zinc-600 mb-2">
            No test generations yet for this workspace.
          </p>
          <p className="text-xs text-zinc-500">
            Tests get generated when you point Inari at a file, function, or
            alert. The slash command <code className="px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">/test src/lib/auth.ts</code> ships
            next.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-left px-4 py-2.5 font-medium">Target</th>
                <th className="text-left px-4 py-2.5 font-medium">Project</th>
                <th className="text-left px-4 py-2.5 font-medium">Framework</th>
                <th className="text-right px-4 py-2.5 font-medium">Cost</th>
                <th className="text-right px-4 py-2.5 font-medium">Duration</th>
                <th className="text-right px-4 py-2.5 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/tests/${r.id}`}
                      className={`inline-flex items-center gap-1.5 ${STATUS_COLOR[r.status] ?? "text-zinc-600"}`}
                    >
                      {statusIcon(r.status)}
                      <span className="text-xs">{STATUS_LABEL[r.status] ?? r.status}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 max-w-md">
                    <Link
                      href={`/tests/${r.id}`}
                      className="font-mono text-xs truncate block hover:underline"
                      title={r.sourceTarget}
                    >
                      {r.sourceTarget}
                    </Link>
                    {r.alertId ? (
                      <span className="text-[10px] text-zinc-500">
                        from{" "}
                        <Link href={`/alerts/${r.alertId}`} className="hover:underline">
                          alert
                        </Link>
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600">
                    {projectName.get(r.projectId) ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600">
                    {r.frameworkDetected ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-zinc-600 tabular-nums">
                    {fmtCost(r.costCents)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-zinc-600 tabular-nums">
                    {fmtDuration(r.durationMs)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-zinc-500">
                    {formatRelativeTime(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination — minimal next/prev */}
      {rows.length === PAGE_SIZE || page > 1 ? (
        <div className="mt-6 flex items-center justify-between text-xs">
          <div>
            {page > 1 ? (
              <Link
                href={`/tests?page=${page - 1}${projectFilter !== "all" ? `&project=${projectFilter}` : ""}`}
                className="text-zinc-600 hover:text-inari-accent"
              >
                ← Newer
              </Link>
            ) : (
              <span />
            )}
          </div>
          <div>
            {rows.length === PAGE_SIZE ? (
              <Link
                href={`/tests?page=${page + 1}${projectFilter !== "all" ? `&project=${projectFilter}` : ""}`}
                className="text-zinc-600 hover:text-inari-accent"
              >
                Older →
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
