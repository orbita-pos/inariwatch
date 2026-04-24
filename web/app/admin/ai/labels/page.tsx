export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import LabelRow from "./_components/LabelRow";

export const metadata: Metadata = { title: "Tier router labels — InariWatch" };

function requireAdmin(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && email === adminEmail;
}

type CandidateRow = {
  id: string;
  alert_id: string;
  alert_title: string | null;
  tier_used: string | null;
  pattern_match_score: number | null;
  status: string;
  monitoring_status: string | null;
  confidence_score: number | null;
  fingerprint: string | null;
  created_at: string;
  existing_label: string | null;
};

async function loadCandidates(limit: number): Promise<CandidateRow[]> {
  const res = await db.execute<CandidateRow>(sql`
    SELECT
      r.id,
      r.alert_id,
      a.title AS alert_title,
      r.tier_used,
      r.pattern_match_score,
      r.status,
      r.monitoring_status,
      r.confidence_score,
      r.fingerprint,
      r.created_at,
      (
        SELECT human_tier
        FROM tier_router_labels l
        WHERE l.session_id = r.id
        ORDER BY l.created_at DESC
        LIMIT 1
      ) AS existing_label
    FROM remediation_sessions r
    LEFT JOIN alerts a ON a.id = r.alert_id
    WHERE r.tier_used IS NOT NULL
      AND r.tier_used <> 'legacy'
      AND r.created_at > now() - interval '30 days'
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `);
  const rows = Array.isArray(res) ? res : ((res as { rows?: CandidateRow[] }).rows ?? []);
  return rows;
}

async function loadStats(): Promise<{ total: number; agreed: number }> {
  const res = await db.execute<{ total: string | number; agreed: string | number }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (l.session_id) l.session_id, l.human_tier
      FROM tier_router_labels l
      ORDER BY l.session_id, l.created_at DESC
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE r.tier_used = latest.human_tier)::int AS agreed
    FROM latest
    JOIN remediation_sessions r ON r.id = latest.session_id
    WHERE r.tier_used IS NOT NULL
  `);
  const rows = Array.isArray(res) ? res : ((res as { rows?: Array<{ total: string | number; agreed: string | number }> }).rows ?? []);
  const row = rows[0];
  const total = typeof row?.total === "number" ? row.total : parseInt(String(row?.total ?? 0), 10) || 0;
  const agreed = typeof row?.agreed === "number" ? row.agreed : parseInt(String(row?.agreed ?? 0), 10) || 0;
  return { total, agreed };
}

export default async function TierRouterLabelsPage() {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  if (!requireAdmin(email)) notFound();

  const [candidates, stats] = await Promise.all([loadCandidates(60), loadStats()]);
  const accuracyPct = stats.total === 0 ? 0 : Math.round((stats.agreed / stats.total) * 100);
  const remainingForGate = Math.max(0, 50 - stats.total);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-10">
          <p className="text-xs font-mono text-violet-400 uppercase tracking-widest mb-1">Admin · Fase 6.1</p>
          <h1 className="text-2xl font-bold">Tier router — human labels</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Label classifier output to power the real accuracy metric. Promotion gate: <span className="text-zinc-300">≥ 50 labels @ ≥ 90% agreement</span>.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
            <p className="text-xs text-zinc-400 mb-1">Labels collected</p>
            <p className="text-3xl font-bold text-white">{stats.total}</p>
            <p className="text-xs text-zinc-500 mt-2">{remainingForGate > 0 ? `${remainingForGate} more to unlock real accuracy` : "Gate unlocked — accuracy is real"}</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
            <p className="text-xs text-zinc-400 mb-1">Classifier vs human</p>
            <p className="text-3xl font-bold text-white">{accuracyPct}<span className="text-base text-zinc-500 ml-1">%</span></p>
            <p className="text-xs text-zinc-500 mt-2">{stats.agreed} / {stats.total} agreed</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
            <p className="text-xs text-zinc-400 mb-1">Promotion threshold</p>
            <p className="text-3xl font-bold text-white">90<span className="text-base text-zinc-500 ml-1">%</span></p>
            <p className="text-xs text-zinc-500 mt-2">From docs/tier-router-rollout.md</p>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
          <div className="border-b border-zinc-800 px-5 py-4">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider">Candidates (last 30 days)</h2>
          </div>
          {candidates.length === 0 ? (
            <p className="px-5 py-8 text-sm text-zinc-500">No classified sessions yet — wait for traffic.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                  <th className="px-5 py-3">Alert</th>
                  <th className="px-5 py-3">Classifier</th>
                  <th className="px-5 py-3">Outcome</th>
                  <th className="px-5 py-3">Pattern score</th>
                  <th className="px-5 py-3">Your label</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <LabelRow
                    key={c.id}
                    sessionId={c.id}
                    alertTitle={c.alert_title ?? "(untitled)"}
                    classifierTier={c.tier_used ?? "?"}
                    status={c.status}
                    monitoringStatus={c.monitoring_status}
                    patternMatchScore={c.pattern_match_score}
                    existingLabel={c.existing_label}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
