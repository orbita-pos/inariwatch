export const dynamic = "force-dynamic";

import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, aiUsageLogs, remediationSessions, alerts } from "@/lib/db";
import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Remediation Session — InariLens" };

function requireAdmin(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && email === adminEmail;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Parse `[tool_use] name(input-json)` response text into structured tool calls
 * for rendering. Multiple tool uses are newline-separated per the logger
 * format in `lib/ai/client.ts:callAIWithTools`.
 */
function parseToolUses(response: string | null): { name: string; input: string }[] {
  if (!response || !response.startsWith("[tool_use]")) return [];
  const body = response.slice("[tool_use]".length).trim();
  return body.split("\n").map((line) => {
    const openParen = line.indexOf("(");
    const lastParen = line.lastIndexOf(")");
    if (openParen < 0 || lastParen < 0 || lastParen < openParen) {
      return { name: line.trim(), input: "" };
    }
    return {
      name: line.slice(0, openParen).trim(),
      input: line.slice(openParen + 1, lastParen),
    };
  });
}

export default async function SessionDetailPage({ params }: PageProps) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  if (!requireAdmin(email)) notFound();

  const { id } = await params;

  // Pull session header + linked alert
  const [rem] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.id, id))
    .limit(1);

  if (!rem) notFound();

  const [alert] = rem.alertId
    ? await db.select().from(alerts).where(eq(alerts.id, rem.alertId)).limit(1)
    : [];

  // Pull all AI calls tied to this session, chronologically
  const calls = await db
    .select()
    .from(aiUsageLogs)
    .where(eq(aiUsageLogs.remediationSessionId, id))
    .orderBy(asc(aiUsageLogs.createdAt));

  const totalCost = calls.reduce((s, c) => s + Number(c.costUsd ?? 0), 0);
  const totalInput = calls.reduce((s, c) => s + (c.inputTokens ?? 0), 0);
  const totalCached = calls.reduce((s, c) => s + (c.cachedInputTokens ?? 0), 0);
  const totalOutput = calls.reduce((s, c) => s + (c.outputTokens ?? 0), 0);
  const totalDuration = calls.reduce((s, c) => s + (c.durationMs ?? 0), 0);
  const cacheHitRate = totalInput > 0 ? (totalCached / totalInput) * 100 : 0;

  const steps = (rem.steps as { name: string; status: string; detail?: string }[]) ?? [];

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 text-xs font-mono text-zinc-500 mb-2">
            <Link href="/admin/ai" className="hover:text-violet-400">Admin / AI</Link>
            <span>/</span>
            <span>Session</span>
          </div>
          <h1 className="text-2xl font-bold font-mono">{id.slice(0, 8)}…</h1>
          <p className="text-sm text-zinc-400 mt-1">
            <StatusBadge status={rem.status} /> · Attempt {rem.attempt}/{rem.maxAttempts}
            {alert && (
              <>
                {" · "}
                <Link href={`/alerts/${alert.id}`} className="text-violet-400 hover:underline">
                  {alert.title?.slice(0, 60) ?? alert.id.slice(0, 8)}
                </Link>
              </>
            )}
            {rem.prUrl && (
              <>
                {" · "}
                <a href={rem.prUrl} target="_blank" rel="noopener" className="text-violet-400 hover:underline">
                  PR
                </a>
              </>
            )}
          </p>
        </div>

        {/* Summary grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Metric label="Total cost" value={`$${totalCost.toFixed(4)}`} highlight />
          <Metric label="AI turns" value={String(calls.length)} />
          <Metric label="Total duration" value={`${(totalDuration / 1000).toFixed(1)}s`} />
          <Metric label="Cache hit" value={`${cacheHitRate.toFixed(0)}%`} />
          <Metric label="Input tokens" value={totalInput.toLocaleString()} small />
          <Metric label="Cached tokens" value={totalCached.toLocaleString()} small />
          <Metric label="Output tokens" value={totalOutput.toLocaleString()} small />
          <Metric label="Confidence" value={rem.confidenceScore ? `${rem.confidenceScore}/100` : "—"} small />
        </div>

        {/* Pipeline steps */}
        {steps.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 mb-8">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
              Pipeline steps ({steps.length})
            </h2>
            <div className="space-y-2">
              {steps.map((step, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <StepStatusDot status={step.status} />
                  <span className="font-mono text-zinc-300">{step.name}</span>
                  {step.detail && (
                    <span className="text-zinc-500 text-xs truncate flex-1">{step.detail}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Turn timeline */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
          <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
            AI turn timeline ({calls.length} calls)
          </h2>
          {calls.length === 0 ? (
            <p className="text-sm text-zinc-500">No AI calls logged for this session.</p>
          ) : (
            <div className="space-y-3">
              {calls.map((c, i) => {
                const toolUses = parseToolUses(c.response);
                const cost = Number(c.costUsd ?? 0);
                return (
                  <details key={c.id} className="group rounded border border-zinc-800 bg-zinc-950">
                    <summary className="cursor-pointer list-none p-3 flex items-center gap-3 text-sm hover:bg-zinc-900/50">
                      <span className="text-zinc-500 font-mono text-xs w-8">#{i + 1}</span>
                      <span className="font-mono text-xs bg-zinc-800 px-2 py-0.5 rounded text-violet-300">
                        {c.feature}
                      </span>
                      <span className="font-mono text-xs text-zinc-400">{c.model}</span>
                      {toolUses.length > 0 && (
                        <span className="text-xs text-amber-400">
                          ⚡ {toolUses.map((t) => t.name).join(", ")}
                        </span>
                      )}
                      {c.error && <span className="text-xs text-red-400">⚠ error</span>}
                      <div className="flex-1" />
                      <span className="text-xs font-mono text-green-400">${cost.toFixed(5)}</span>
                      <span className="text-xs font-mono text-zinc-500">
                        {c.durationMs ? `${c.durationMs}ms` : ""}
                      </span>
                      <span className="text-xs text-zinc-500">
                        in {c.inputTokens} / out {c.outputTokens}
                        {c.cachedInputTokens > 0 && ` · ${c.cachedInputTokens} cached`}
                      </span>
                    </summary>
                    <div className="border-t border-zinc-800 p-4 space-y-3 text-xs">
                      {toolUses.length > 0 && (
                        <div>
                          <div className="text-zinc-400 mb-2">Tool calls</div>
                          <div className="space-y-1">
                            {toolUses.map((t, j) => (
                              <div key={j} className="font-mono bg-zinc-900 rounded px-2 py-1">
                                <span className="text-amber-400">{t.name}</span>
                                <span className="text-zinc-500">({t.input.slice(0, 200)}{t.input.length > 200 ? "…" : ""})</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {c.error && (
                        <div className="text-red-400 font-mono bg-red-950/30 rounded p-2">
                          {c.error}
                        </div>
                      )}
                      <div className="text-zinc-400">
                        <Link
                          href={`/admin/ai/calls/${c.requestId}`}
                          className="text-violet-400 hover:underline"
                        >
                          View full prompt + response →
                        </Link>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  highlight,
  small,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-xs text-zinc-400">{label}</p>
      <p
        className={
          small
            ? "text-lg font-mono text-zinc-300 mt-1"
            : highlight
              ? "text-2xl font-bold text-green-400 mt-1"
              : "text-2xl font-bold text-white mt-1"
        }
      >
        {value}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "completed" || status === "approved" || status === "merging"
      ? "text-green-400"
      : status === "failed" || status === "cancelled"
        ? "text-red-400"
        : "text-amber-400";
  return <span className={`font-mono text-xs ${color}`}>{status}</span>;
}

function StepStatusDot({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "bg-green-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "in_progress"
          ? "bg-amber-500 animate-pulse"
          : "bg-zinc-600";
  return <div className={`w-2 h-2 rounded-full ${color} shrink-0`} />;
}
