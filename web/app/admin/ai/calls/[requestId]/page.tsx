export const dynamic = "force-dynamic";

import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, aiUsageLogs } from "@/lib/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ReplayPanel } from "./replay";

export const metadata: Metadata = { title: "AI Call Detail — InariWatch" };

function requireAdmin(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && email === adminEmail;
}

export default async function AICallDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  if (!requireAdmin(email)) notFound();

  const { requestId } = await params;

  const [row] = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.requestId, requestId)).limit(1);
  if (!row) notFound();

  const relatedCalls = row.alertId
    ? await db
        .select()
        .from(aiUsageLogs)
        .where(and(eq(aiUsageLogs.alertId, row.alertId), ne(aiUsageLogs.requestId, requestId)))
        .orderBy(desc(aiUsageLogs.createdAt))
        .limit(20)
    : [];

  const cost = parseFloat(row.costUsd);
  const createdAt = new Date(row.createdAt);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-violet-400 uppercase tracking-widest mb-1">
              Admin · InariLens
            </p>
            <h1 className="text-2xl font-bold">AI Call Detail</h1>
            <p className="text-xs font-mono text-zinc-500 mt-1">request_id: {row.requestId}</p>
            <p className="text-xs text-zinc-400 mt-2">
              {createdAt.toISOString()} · {row.durationMs != null ? `${row.durationMs}ms` : "—"} ·{" "}
              ${cost.toFixed(6)} · {row.cached ? "cached" : "not cached"}
              {row.error && <span className="text-red-400"> · failed</span>}
            </p>
          </div>
          <Link href="/admin/ai/calls" className="text-xs text-zinc-400 hover:text-white underline">
            ← all calls
          </Link>
        </div>

        {/* Metadata */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 mb-6">
          <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">Metadata</h2>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <Field label="Feature" value={<span className="font-mono">{row.feature}</span>} />
            <Field label="Provider" value={<span>{row.provider}</span>} />
            <Field label="Model" value={<span className="font-mono">{row.model}</span>} />
            <Field label="Platform key" value={row.isPlatformKey ? "yes" : "no"} />
            <Field
              label="Tokens"
              value={
                <span className="font-mono">
                  {row.inputTokens.toLocaleString()} in → {row.outputTokens.toLocaleString()} out
                  {row.cachedInputTokens > 0 && (
                    <span className="text-blue-400"> · {row.cachedInputTokens.toLocaleString()} cached</span>
                  )}
                </span>
              }
            />
            <Field label="Cost" value={<span className="font-mono">${cost.toFixed(8)}</span>} />
            <Field
              label="User"
              value={<span className="font-mono text-xs text-zinc-400">{row.userId}</span>}
            />
            {row.projectId && (
              <Field
                label="Project"
                value={<span className="font-mono text-xs text-zinc-400">{row.projectId}</span>}
              />
            )}
            {row.alertId && (
              <Field
                label="Alert"
                value={
                  <Link
                    href={`/alerts/${row.alertId}`}
                    className="font-mono text-xs text-violet-400 hover:underline"
                  >
                    {row.alertId}
                  </Link>
                }
              />
            )}
            {row.remediationSessionId && (
              <Field
                label="Remediation"
                value={
                  <span className="font-mono text-xs text-zinc-400">{row.remediationSessionId}</span>
                }
              />
            )}
            {row.replayOfRequestId && (
              <Field
                label="Replay of"
                value={
                  <Link
                    href={`/admin/ai/calls/${row.replayOfRequestId}`}
                    className="font-mono text-xs text-violet-400 hover:underline"
                  >
                    {row.replayOfRequestId}
                  </Link>
                }
              />
            )}
            {row.error && (
              <Field
                label="Error"
                value={<span className="text-red-400 text-xs font-mono">{row.error}</span>}
              />
            )}
          </dl>
        </div>

        {/* Prompt */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider">
              Prompt {row.inputTokens > 0 && <span className="text-zinc-500">({row.inputTokens.toLocaleString()} tokens)</span>}
            </h2>
          </div>
          {row.prompt ? (
            <pre className="text-xs font-mono whitespace-pre-wrap bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 max-h-[60vh] overflow-auto">
              {row.prompt}
            </pre>
          ) : (
            <NotCaptured />
          )}
        </div>

        {/* Response */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider">
              Response {row.outputTokens > 0 && <span className="text-zinc-500">({row.outputTokens.toLocaleString()} tokens)</span>}
            </h2>
          </div>
          {row.response ? (
            <pre className="text-xs font-mono whitespace-pre-wrap bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 max-h-[60vh] overflow-auto">
              {row.response}
            </pre>
          ) : (
            <NotCaptured />
          )}
        </div>

        {/* Replay */}
        {row.prompt && (
          <div className="mb-6">
            <ReplayPanel requestId={row.requestId} />
          </div>
        )}

        {/* Related calls */}
        {relatedCalls.length > 0 && (
          <div>
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-3">
              Related calls (same alert)
            </h2>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-zinc-950/50 border-b border-zinc-800">
                  <tr className="text-left text-zinc-500">
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Feature</th>
                    <th className="px-3 py-2">Model</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-right">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {relatedCalls.map((c) => (
                    <tr key={c.requestId} className="border-b border-zinc-900 hover:bg-zinc-900/40">
                      <td className="px-3 py-2 font-mono text-zinc-400">
                        <Link
                          href={`/admin/ai/calls/${c.requestId}`}
                          className="hover:text-white hover:underline"
                        >
                          {new Date(c.createdAt).toLocaleString()}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono">{c.feature}</td>
                      <td className="px-3 py-2 font-mono text-zinc-300">{c.model}</td>
                      <td className="px-3 py-2 text-right font-mono">${parseFloat(c.costUsd).toFixed(6)}</td>
                      <td className="px-3 py-2 text-right text-zinc-400">
                        {c.durationMs != null ? `${c.durationMs}ms` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 mb-0.5">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function NotCaptured() {
  return (
    <div className="text-xs text-zinc-500 italic p-4 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30">
      Prompt/response not captured — this call predates InariLens or was logged via the legacy path.
    </div>
  );
}
