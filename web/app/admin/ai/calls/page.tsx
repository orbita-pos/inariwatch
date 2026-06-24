export const dynamic = "force-dynamic";

import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, aiUsageLogs } from "@/lib/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "AI Calls — InariWatch" };

const PAGE_SIZE = 50;

function requireAdmin(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && email === adminEmail;
}

interface SearchParams {
  feature?: string;
  model?: string;
  provider?: string;
  alertId?: string;
  cached?: string;
  error?: string;
  page?: string;
}

export default async function AICallsListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  if (!requireAdmin(email)) notFound();

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions = [];
  if (params.feature) conditions.push(eq(aiUsageLogs.feature, params.feature));
  if (params.model) conditions.push(eq(aiUsageLogs.model, params.model));
  if (params.provider) conditions.push(eq(aiUsageLogs.provider, params.provider));
  if (params.alertId) conditions.push(eq(aiUsageLogs.alertId, params.alertId));
  if (params.cached === "true") conditions.push(eq(aiUsageLogs.cached, true));
  if (params.error === "true") conditions.push(isNotNull(aiUsageLogs.error));
  const whereClause = conditions.length ? and(...conditions) : undefined;

  const [rows, summaryRows, distinctRows] = await Promise.all([
    db.select().from(aiUsageLogs).where(whereClause).orderBy(desc(aiUsageLogs.createdAt)).limit(PAGE_SIZE).offset(offset),
    db
      .select({
        total: sql<number>`COUNT(*)::int`,
        totalCost: sql<string>`COALESCE(SUM(${aiUsageLogs.costUsd}), 0)::text`,
        cacheHits: sql<number>`COUNT(*) FILTER (WHERE ${aiUsageLogs.cached} = true)::int`,
        errorCount: sql<number>`COUNT(*) FILTER (WHERE ${aiUsageLogs.error} IS NOT NULL)::int`,
        p50: sql<string>`COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${aiUsageLogs.durationMs}), 0)::text`,
        p95: sql<string>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${aiUsageLogs.durationMs}), 0)::text`,
      })
      .from(aiUsageLogs)
      .where(whereClause),
    db
      .selectDistinct({ feature: aiUsageLogs.feature, provider: aiUsageLogs.provider })
      .from(aiUsageLogs),
  ]);

  const summary = summaryRows[0] ?? { total: 0, totalCost: "0", cacheHits: 0, errorCount: 0, p50: "0", p95: "0" };
  const features = Array.from(new Set(distinctRows.map((r) => r.feature))).sort();
  const providers = Array.from(new Set(distinctRows.map((r) => r.provider))).sort();

  const total = Number(summary.total) || 0;
  const cacheHitRate = total > 0 ? (Number(summary.cacheHits) / total) * 100 : 0;
  const errorRate = total > 0 ? (Number(summary.errorCount) / total) * 100 : 0;

  const sameAlertCalls = params.alertId
    ? await db
        .select()
        .from(aiUsageLogs)
        .where(eq(aiUsageLogs.alertId, params.alertId))
        .orderBy(aiUsageLogs.createdAt)
    : [];

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-violet-400 uppercase tracking-widest mb-1">Admin · InariLens</p>
            <h1 className="text-2xl font-bold">AI Calls</h1>
          </div>
          <Link href="/admin/ai" className="text-xs text-zinc-400 hover:text-white underline">
            ← back to overview
          </Link>
        </div>

        {/* Summary bar */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <StatCard label="Calls" value={total.toLocaleString()} />
          <StatCard label="Total cost" value={`$${parseFloat(summary.totalCost).toFixed(4)}`} />
          <StatCard label="Cache hit rate" value={`${cacheHitRate.toFixed(1)}%`} tone={cacheHitRate > 30 ? "good" : "neutral"} />
          <StatCard label="Error rate" value={`${errorRate.toFixed(1)}%`} tone={errorRate > 5 ? "bad" : "good"} />
          <StatCard label="p50 / p95" value={`${Math.round(parseFloat(summary.p50))}ms / ${Math.round(parseFloat(summary.p95))}ms`} />
        </div>

        {/* Filters */}
        <form method="get" className="flex flex-wrap gap-3 mb-6 p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
          <FilterSelect name="feature" value={params.feature ?? ""} label="Feature" options={features} />
          <FilterSelect name="provider" value={params.provider ?? ""} label="Provider" options={providers} />
          <FilterInput name="model" value={params.model ?? ""} label="Model" placeholder="gpt-4o-mini" />
          <FilterInput name="alertId" value={params.alertId ?? ""} label="Alert ID" placeholder="uuid" />
          <FilterSelect name="cached" value={params.cached ?? ""} label="Cached" options={["true", "false"]} />
          <FilterSelect name="error" value={params.error ?? ""} label="Errors only" options={["true"]} />
          <div className="flex items-end gap-2">
            <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-500 rounded">
              Apply
            </button>
            <Link href="/admin/ai/calls" className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white underline">
              clear
            </Link>
          </div>
        </form>

        {/* Table */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          {rows.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 text-sm">
              No calls match these filters. Waiting for traffic — once any AI feature runs, rows will appear here.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-zinc-950/50 border-b border-zinc-800">
                <tr className="text-left text-xs text-zinc-500">
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Feature</th>
                  <th className="px-3 py-2">Provider / Model</th>
                  <th className="px-3 py-2 text-right">Tokens (in → out)</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Duration</th>
                  <th className="px-3 py-2 text-center">Cached</th>
                  <th className="px-3 py-2 text-center">Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.requestId} className="border-b border-zinc-900 hover:bg-zinc-900/40">
                    <td className="px-3 py-2 text-xs font-mono text-zinc-400">
                      <Link href={`/admin/ai/calls/${r.requestId}`} className="hover:text-white hover:underline">
                        {new Date(r.createdAt).toLocaleString()}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{r.feature}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="text-zinc-400">{r.provider}</span>
                      <span className="text-zinc-600"> / </span>
                      <span className="font-mono">{r.model}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono text-zinc-300">
                      {r.inputTokens.toLocaleString()} → {r.outputTokens.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono">
                      ${parseFloat(r.costUsd).toFixed(6)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-zinc-400">
                      {r.durationMs != null ? `${r.durationMs}ms` : "—"}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {r.cached ? <span className="text-blue-400">✓</span> : <span className="text-zinc-600">·</span>}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {r.error ? <span className="text-red-400">✗</span> : <span className="text-zinc-600">·</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-4 text-xs text-zinc-400">
            <div>
              Page {page} · showing {offset + 1}–{Math.min(offset + rows.length, total)} of {total.toLocaleString()}
            </div>
            <div className="flex gap-2">
              {page > 1 && (
                <PageLink params={params} page={page - 1} label="← prev" />
              )}
              {offset + rows.length < total && (
                <PageLink params={params} page={page + 1} label="next →" />
              )}
            </div>
          </div>
        )}

        {/* Alert flow timeline */}
        {params.alertId && sameAlertCalls.length > 0 && (
          <div className="mt-10">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-3">
              Alert flow ({sameAlertCalls.length} calls)
            </h2>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <ol className="space-y-2">
                {sameAlertCalls.map((c) => (
                  <li key={c.requestId} className="flex items-center gap-4 text-xs font-mono">
                    <span className="text-zinc-500 w-20">
                      {new Date(c.createdAt).toLocaleTimeString()}
                    </span>
                    <span className="w-32 text-zinc-300">{c.feature}</span>
                    <span className="w-20 text-zinc-400">{c.provider}</span>
                    <span className="flex-1 text-zinc-300">{c.model}</span>
                    <span className="w-24 text-right">${parseFloat(c.costUsd).toFixed(6)}</span>
                    <span className="w-16 text-right text-zinc-400">
                      {c.durationMs != null ? `${c.durationMs}ms` : "—"}
                    </span>
                    <Link
                      href={`/admin/ai/calls/${c.requestId}`}
                      className="text-violet-400 hover:text-violet-300 hover:underline"
                    >
                      detail
                    </Link>
                  </li>
                ))}
              </ol>
              <div className="mt-4 pt-3 border-t border-zinc-800 flex justify-between text-xs text-zinc-400">
                <span>
                  Total:{" "}
                  <span className="font-mono text-white">
                    $
                    {sameAlertCalls
                      .reduce((s, c) => s + parseFloat(c.costUsd), 0)
                      .toFixed(6)}
                  </span>
                </span>
                <span>
                  avg latency:{" "}
                  <span className="font-mono text-white">
                    {sameAlertCalls.filter((c) => c.durationMs != null).length > 0
                      ? Math.round(
                          sameAlertCalls.reduce((s, c) => s + (c.durationMs ?? 0), 0) /
                            Math.max(1, sameAlertCalls.filter((c) => c.durationMs != null).length)
                        )
                      : 0}
                    ms
                  </span>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  const color = tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-white";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function FilterSelect({ name, value, label, options }: { name: string; value: string; label: string; options: string[] }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-500">{label}</span>
      <select
        name={name}
        defaultValue={value}
        className="px-2 py-1 text-xs bg-zinc-950 border border-zinc-800 rounded text-white min-w-[140px]"
      >
        <option value="">all</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterInput({ name, value, label, placeholder }: { name: string; value: string; label: string; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-500">{label}</span>
      <input
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        className="px-2 py-1 text-xs bg-zinc-950 border border-zinc-800 rounded text-white min-w-[160px]"
      />
    </label>
  );
}

function PageLink({ params, page, label }: { params: SearchParams; page: number; label: string }) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== "page") search.set(k, v);
  }
  search.set("page", String(page));
  return (
    <Link
      href={`/admin/ai/calls?${search.toString()}`}
      className="px-3 py-1 text-xs border border-zinc-700 rounded hover:bg-zinc-800"
    >
      {label}
    </Link>
  );
}
