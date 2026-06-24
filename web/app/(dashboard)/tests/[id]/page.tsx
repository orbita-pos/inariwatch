import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, testGenerationSessions } from "@/lib/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { formatRelativeTime } from "@/lib/utils";
import { CheckCircle2, XCircle, FileCode, ArrowLeft, Sparkles, Shield } from "lucide-react";

import type { TestPlan, TestPlanCase, TestReviewResult } from "@/lib/ai/prompts";
import type { QualityGatesResult } from "@/lib/ai/test-quality-gates";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({
  params,
}: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Test session ${id.slice(0, 8)} · Inari Guard` };
}

export default async function TestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return (
      <div className="p-8">
        <p className="text-sm text-zinc-600">Please sign in.</p>
      </div>
    );
  }

  const [row] = await db
    .select()
    .from(testGenerationSessions)
    .where(eq(testGenerationSessions.id, id))
    .limit(1);
  if (!row) notFound();

  // Authorize
  if (row.userId !== userId) {
    const [project] = await db
      .select({ userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .limit(1);
    if (!project || project.userId !== userId) notFound();
  }

  const plan        = row.testPlan       as TestPlan | null;
  const review      = row.reviewResult   as TestReviewResult | null;
  const gates       = row.qualityGates   as QualityGatesResult | null;
  const testFiles   = row.testFiles      as { path: string; content: string }[] | null;
  const modelsUsed  = row.modelsUsed     as { plan?: string; write?: string; review?: string } | null;
  const tokensIn    = row.tokensIn       as { plan?: number; write?: number; review?: number } | null;
  const tokensOut   = row.tokensOut      as { plan?: number; write?: number; review?: number } | null;
  const verification = row.verification   as
    | { command?: string; exit_code?: number; passed?: number; failed?: number; stdout?: string; stderr?: string }
    | null;

  const ok = row.status === "ready" || row.status === "delivered";

  return (
    <div className="p-8 max-w-5xl">
      {/* ── Back nav */}
      <Link
        href="/tests"
        className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 mb-4"
      >
        <ArrowLeft size={12} /> All test generations
      </Link>

      {/* ── Header */}
      <div className="flex items-start justify-between mb-2">
        <div>
          <h1 className="text-2xl font-light tracking-tight mb-1 flex items-center gap-2">
            {ok ? (
              <CheckCircle2 size={20} className="text-emerald-500" aria-hidden />
            ) : row.status === "failed" ? (
              <XCircle size={20} className="text-red-500" aria-hidden />
            ) : (
              <Sparkles size={20} className="text-zinc-400" aria-hidden />
            )}
            <span className="font-mono text-base">{row.sourceTarget}</span>
          </h1>
          <p className="text-sm text-zinc-600">
            {row.sourceKind} · {row.frameworkDetected ?? "framework auto-detected"} · {formatRelativeTime(row.createdAt)}
          </p>
        </div>
        <div className="text-right text-xs text-zinc-500 tabular-nums">
          {row.costCents > 0 ? (
            <div>
              <div className="text-zinc-700 dark:text-zinc-200 font-medium">
                ${(row.costCents / 100).toFixed(3)}
              </div>
              <div>{row.durationMs ? `${(row.durationMs / 1000).toFixed(1)}s` : ""}</div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Error banner (if failed) */}
      {row.error ? (
        <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 mb-6 text-sm text-red-700 dark:text-red-300">
          {row.error}
        </div>
      ) : null}

      {/* ── Cost / model breakdown */}
      {modelsUsed ? (
        <div className="grid grid-cols-3 gap-3 mb-6">
          <ModelCard
            label="Plan"
            model={modelsUsed.plan ?? "—"}
            tokensIn={tokensIn?.plan}
            tokensOut={tokensOut?.plan}
          />
          <ModelCard
            label="Write"
            model={modelsUsed.write ?? "—"}
            tokensIn={tokensIn?.write}
            tokensOut={tokensOut?.write}
          />
          <ModelCard
            label="Review"
            model={modelsUsed.review ?? "—"}
            tokensIn={tokensIn?.review}
            tokensOut={tokensOut?.review}
          />
        </div>
      ) : null}

      {/* ── Quality gates */}
      {gates ? (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider font-medium text-zinc-500 mb-2 flex items-center gap-1.5">
            <Shield size={12} /> Quality gates
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
            <div className="text-xs space-y-1">
              {gates.passed.map((p, i) => (
                <div key={`p-${i}`} className="text-emerald-600 dark:text-emerald-400 flex items-start gap-1.5">
                  <CheckCircle2 size={12} className="mt-0.5 shrink-0" aria-hidden />
                  <span>{p}</span>
                </div>
              ))}
              {gates.failed.map((f, i) => (
                <div key={`f-${i}`} className="text-red-600 dark:text-red-400 flex items-start gap-1.5">
                  <XCircle size={12} className="mt-0.5 shrink-0" aria-hidden />
                  <span>{f}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Test plan */}
      {plan && plan.cases.length > 0 ? (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider font-medium text-zinc-500 mb-2">
            Plan ({plan.cases.length} cases · framework={plan.framework})
          </h2>
          <ul className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
            {plan.cases.map((c: TestPlanCase, i: number) => (
              <li key={i} className="px-4 py-2.5 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-zinc-500 mt-0.5">{c.scenario}</div>
                  </div>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      c.priority === "high"
                        ? "bg-inari-accent/10 text-inari-accent"
                        : c.priority === "medium"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500"
                    }`}
                  >
                    {c.priority}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── AI reviewer verdict */}
      {review ? (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider font-medium text-zinc-500 mb-2">
            AI Reviewer verdict {review.score != null ? `· score ${review.score}/100` : ""}
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-xs">
            <div className={`font-medium mb-2 ${review.approved ? "text-emerald-600" : "text-red-600"}`}>
              {review.approved ? "Approved" : "Rejected"}
            </div>
            {review.concerns?.length ? (
              <ul className="text-zinc-600 list-disc list-inside space-y-0.5">
                {review.concerns.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            ) : null}
            {review.rewrite_hint && !review.approved ? (
              <div className="mt-2 text-zinc-700 dark:text-zinc-300">
                <span className="text-zinc-500">Rewrite hint:</span> {review.rewrite_hint}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Verification (test run output, when present) */}
      {verification ? (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider font-medium text-zinc-500 mb-2">
            Verification
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-xs">
            <div className="font-mono text-zinc-700 dark:text-zinc-300">{verification.command ?? "—"}</div>
            <div className="mt-2 text-zinc-500">
              Exit code: <span className="text-zinc-700 dark:text-zinc-200">{verification.exit_code ?? "—"}</span>
              {verification.passed != null
                ? ` · ${verification.passed} pass, ${verification.failed ?? 0} fail`
                : ""}
            </div>
            {verification.stdout ? (
              <pre className="mt-2 bg-zinc-50 dark:bg-zinc-900 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
                {verification.stdout.slice(0, 4000)}
              </pre>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Generated test file */}
      {testFiles && testFiles.length > 0 ? (
        <section>
          <h2 className="text-xs uppercase tracking-wider font-medium text-zinc-500 mb-2 flex items-center gap-1.5">
            <FileCode size={12} /> Generated test{testFiles.length === 1 ? "" : "s"}
          </h2>
          {testFiles.map((f, i) => (
            <div key={i} className="rounded-lg border border-zinc-200 dark:border-zinc-800 mb-3 overflow-hidden">
              <div className="bg-zinc-50 dark:bg-zinc-900/50 px-3 py-2 text-xs font-mono border-b border-zinc-200 dark:border-zinc-800">
                {f.path}
              </div>
              <pre className="bg-zinc-50/30 dark:bg-zinc-900/30 p-4 text-[11px] overflow-x-auto font-mono whitespace-pre-wrap break-all">
                {f.content}
              </pre>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

// ── Small atoms ──────────────────────────────────────────────────────────────

function ModelCard({
  label,
  model,
  tokensIn,
  tokensOut,
}: {
  label: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}) {
  // Shorten common Together IDs for display
  const shortModel = model
    .replace(/^Qwen\//, "")
    .replace(/^moonshotai\//, "")
    .replace(/^deepseek-ai\//, "");
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      <div className="text-xs font-mono text-zinc-700 dark:text-zinc-200 truncate" title={model}>
        {shortModel}
      </div>
      {tokensIn != null && tokensOut != null ? (
        <div className="text-[10px] text-zinc-500 mt-1 tabular-nums">
          {tokensIn.toLocaleString()} in · {tokensOut.toLocaleString()} out
        </div>
      ) : null}
    </div>
  );
}
