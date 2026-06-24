/**
 * GET /api/admin/rollout-gates — single-shot rollout readiness audit.
 *
 * Auth: Bearer CRON_SECRET (timing-safe). Same convention as /api/cron/*.
 *
 * Reports the three canaries that gate "boom" features:
 *   1. Multi-agent fanout activity
 *   2. Substrate v2 in-loop replay agreement
 *   3. Tier-router shadow→live promotion gates (5 from rollout playbook)
 *
 * Read-only. Idempotent. Cheap (~10 SELECT COUNT queries).
 *
 * Usage from local:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://app.inariwatch.com/api/admin/rollout-gates | jq
 */

import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const CRON_SECRET = process.env.CRON_SECRET;

type Verdict = "GREEN" | "YELLOW" | "RED" | "N/A";

async function tableExists(name: string): Promise<boolean> {
  try {
    const r = (await db.execute(sql`SELECT to_regclass(${name})::text AS reg`)) as unknown as Array<{ reg: string | null }>;
    return r[0]?.reg !== null;
  } catch {
    return false;
  }
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function GET(req: Request) {
  const start = Date.now();

  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 0. Schema sanity ────────────────────────────────────────────────────────
  const tables = {
    remediation_sessions: await tableExists("remediation_sessions"),
    ai_usage_logs: await tableExists("ai_usage_logs"),
    pattern_memory: await tableExists("pattern_memory"),
    tier_router_labels: await tableExists("tier_router_labels"),
    slo_events: await tableExists("slo_events"),
    substrate_replay_comparisons: await tableExists("substrate_replay_comparisons"),
  };
  const missing = Object.entries(tables).filter(([, v]) => !v).map(([k]) => k);

  // ── 1. Volume baseline ──────────────────────────────────────────────────────
  const vol = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        COUNT(*)::int                                                                   AS total_5d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int           AS total_24h,
        COUNT(*) FILTER (WHERE status = 'completed')::int                               AS completed_5d,
        COUNT(*) FILTER (WHERE status = 'failed')::int                                  AS failed_5d,
        COUNT(*) FILTER (WHERE tier_used IS NOT NULL)::int                              AS classified_5d
      FROM remediation_sessions
      WHERE created_at > NOW() - INTERVAL '5 days'
    `)) as unknown as Array<{ total_5d: number; total_24h: number; completed_5d: number; failed_5d: number; classified_5d: number }>;
    return r[0] ?? { total_5d: 0, total_24h: 0, completed_5d: 0, failed_5d: 0, classified_5d: 0 };
  }, { total_5d: 0, total_24h: 0, completed_5d: 0, failed_5d: 0, classified_5d: 0 });

  const dailyAvg = vol.total_5d / 5;
  let volumeVerdict: Verdict = "RED";
  if (dailyAvg >= 50) volumeVerdict = "GREEN";
  else if (dailyAvg >= 10) volumeVerdict = "YELLOW";

  // ── 2. Tier-router gates ────────────────────────────────────────────────────
  // Gate #1 — human agreement on labels
  const lab = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT COUNT(*)::int AS labeled,
             COUNT(*) FILTER (WHERE l.human_tier = s.tier_used)::int AS agreed
      FROM tier_router_labels l
      JOIN remediation_sessions s ON s.id = l.session_id
      WHERE s.tier_used IS NOT NULL
    `)) as unknown as Array<{ labeled: number; agreed: number }>;
    return r[0] ?? { labeled: 0, agreed: 0 };
  }, { labeled: 0, agreed: 0 });
  const agreementPct = lab.labeled > 0 ? (lab.agreed * 100) / lab.labeled : 0;
  let gate1: Verdict = "RED";
  if (lab.labeled >= 50 && agreementPct >= 90) gate1 = "GREEN";
  else if (lab.labeled >= 50 && agreementPct >= 80) gate1 = "YELLOW";

  // Gate #2 — classifier latency p95
  const lat = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        COUNT(*)::int AS n,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99
      FROM ai_usage_logs
      WHERE phase = 'classify'
        AND created_at > NOW() - INTERVAL '5 days'
        AND duration_ms IS NOT NULL
    `)) as unknown as Array<{ n: number; p50: number; p95: number; p99: number }>;
    return r[0] ?? { n: 0, p50: 0, p95: 0, p99: 0 };
  }, { n: 0, p50: 0, p95: 0, p99: 0 });
  let gate2: Verdict = "N/A";
  if (lat.n >= 30) gate2 = lat.p95 < 200 ? "GREEN" : lat.p95 < 400 ? "YELLOW" : "RED";

  // Gate #3 — open SLO breaches
  const inc = tables.slo_events
    ? await safe(async () => {
        const r = (await db.execute(sql`
          SELECT COUNT(*)::int AS open_breaches,
                 STRING_AGG(DISTINCT tier || ':' || metric, ', ') AS metrics
          FROM slo_events
          WHERE resolved_at IS NULL
            AND created_at > NOW() - INTERVAL '5 days'
        `)) as unknown as Array<{ open_breaches: number; metrics: string | null }>;
        return r[0] ?? { open_breaches: 0, metrics: null };
      }, { open_breaches: 0, metrics: null as string | null })
    : { open_breaches: 0, metrics: null as string | null };
  const gate3: Verdict = !tables.slo_events ? "N/A" : (inc.open_breaches === 0 ? "GREEN" : "YELLOW");

  // Gate #4 — pattern memory health
  const pm = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        COUNT(*)::int                                               AS total,
        COUNT(*) FILTER (WHERE success_count >= 3)::int             AS qualified,
        COUNT(*) FILTER (WHERE disabled_at IS NOT NULL)::int        AS disabled,
        COUNT(DISTINCT project_id)::int                             AS distinct_projects
      FROM pattern_memory
    `)) as unknown as Array<{ total: number; qualified: number; disabled: number; distinct_projects: number }>;
    return r[0] ?? { total: 0, qualified: 0, disabled: 0, distinct_projects: 0 };
  }, { total: 0, qualified: 0, disabled: 0, distinct_projects: 0 });
  let gate4: Verdict = "RED";
  if (pm.total >= 30 && pm.qualified >= 5) gate4 = "GREEN";
  else if (pm.total >= 15 && pm.qualified >= 2) gate4 = "YELLOW";

  // ── 3. Substrate v2 ─────────────────────────────────────────────────────────
  const sub = tables.substrate_replay_comparisons
    ? await safe(async () => {
        const r = (await db.execute(sql`
          SELECT
            COUNT(*)::int                                       AS total,
            COUNT(*) FILTER (WHERE v1_passed IS NOT NULL AND v2_passed IS NOT NULL)::int AS both_ran,
            COUNT(*) FILTER (WHERE v1_passed = v2_passed)::int  AS agreement,
            COUNT(*) FILTER (WHERE v1_passed = true  AND v2_passed = false)::int AS v1pass_v2fail,
            COUNT(*) FILTER (WHERE v1_passed = false AND v2_passed = true)::int  AS v1fail_v2pass
          FROM substrate_replay_comparisons
          WHERE created_at > NOW() - INTERVAL '5 days'
        `)) as unknown as Array<{ total: number; both_ran: number; agreement: number; v1pass_v2fail: number; v1fail_v2pass: number }>;
        return r[0] ?? { total: 0, both_ran: 0, agreement: 0, v1pass_v2fail: 0, v1fail_v2pass: 0 };
      }, { total: 0, both_ran: 0, agreement: 0, v1pass_v2fail: 0, v1fail_v2pass: 0 })
    : { total: 0, both_ran: 0, agreement: 0, v1pass_v2fail: 0, v1fail_v2pass: 0 };
  const subAgreementPct = sub.both_ran > 0 ? (sub.agreement * 100) / sub.both_ran : 0;
  let subVerdict: Verdict = "RED";
  if (!tables.substrate_replay_comparisons) subVerdict = "N/A";
  else if (sub.both_ran >= 30 && subAgreementPct >= 95) subVerdict = "GREEN";
  else if (sub.both_ran >= 10 && subAgreementPct >= 85) subVerdict = "YELLOW";
  else if (sub.both_ran === 0) subVerdict = "N/A";

  // ── 4. Multi-agent fanout activity ──────────────────────────────────────────
  const fan = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        COUNT(*)::int                                                AS sessions_5d,
        COUNT(*) FILTER (WHERE hypothesis_count IS NOT NULL AND hypothesis_count > 0)::int AS with_fanout,
        COUNT(*) FILTER (WHERE hypothesis_count > 1)::int            AS multi_hypothesis,
        AVG(hypothesis_count) FILTER (WHERE hypothesis_count > 0)::float AS avg_hypotheses
      FROM remediation_sessions
      WHERE created_at > NOW() - INTERVAL '5 days'
    `)) as unknown as Array<{ sessions_5d: number; with_fanout: number; multi_hypothesis: number; avg_hypotheses: number | null }>;
    return r[0] ?? { sessions_5d: 0, with_fanout: 0, multi_hypothesis: 0, avg_hypotheses: null };
  }, { sessions_5d: 0, with_fanout: 0, multi_hypothesis: 0, avg_hypotheses: null });
  const fanoutPct = fan.sessions_5d > 0 ? (fan.with_fanout * 100) / fan.sessions_5d : 0;
  const fanReady: Verdict = fan.with_fanout >= 10 ? "GREEN" : fan.with_fanout >= 1 ? "YELLOW" : "N/A";

  // ── 5. Recommendations ──────────────────────────────────────────────────────
  const recommendations: Array<{ feature: string; verdict: string; action: string }> = [];

  recommendations.push({
    feature: "multi_agent_fanout",
    verdict: fanReady === "GREEN" ? "ramp" : fanReady === "YELLOW" ? "soak" : "investigate",
    action:
      fanReady === "GREEN"
        ? "kamal env push -d production -e FANOUT_CANARY_PCT=50 (then soak 24h, then 100)"
        : fanReady === "YELLOW"
          ? `Soak — only ${fan.with_fanout} fanout sessions in 5d. Wait for more or check MULTI_AGENT_FANOUT firing.`
          : "Zero fanout activity. Verify MULTI_AGENT_FANOUT=true in deploy.yml is actually live and traffic is reaching the worker.",
  });

  recommendations.push({
    feature: "substrate_v2_inloop",
    verdict: subVerdict === "GREEN" ? "ramp_blocking" : subVerdict === "N/A" ? "verify" : "diverge",
    action:
      subVerdict === "GREEN"
        ? "Increase canary pct in substrate-replay.ts:622 from 5% → 25% → 100% drain. Then flip blocking mode."
        : subVerdict === "N/A"
          ? "No comparison rows. Verify SUBSTRATE_V2_GATE=true firing + binary at /usr/local/bin/substrate-v2-replay on Hetzner. Smoke: curl https://api.staging.inariwatch.com/v2/replay"
          : `v1/v2 agreement ${subAgreementPct.toFixed(1)}%. Investigate divergence in substrate_replay_comparisons before ramping.`,
  });

  const tierGates = [gate1, gate2, gate3, gate4];
  const greenCount = tierGates.filter(g => g === "GREEN").length;
  const redCount = tierGates.filter(g => g === "RED").length;
  if (redCount === 0 && greenCount >= 3) {
    recommendations.push({
      feature: "tier_router",
      verdict: "promote",
      action: "Write approval doc, then kamal env push -d production -e TIER_ROUTER_MODE=live (canary 10% → 50% → 100%)",
    });
  } else {
    const blockers: string[] = [];
    if (gate1 !== "GREEN") blockers.push(`gate1 (${lab.labeled} labels, ${agreementPct.toFixed(1)}% agreement; need ≥50/90%)`);
    if (gate2 !== "GREEN" && gate2 !== "N/A") blockers.push(`gate2 (p95 ${lat.p95}ms; need <200ms)`);
    if (gate3 !== "GREEN" && gate3 !== "N/A") blockers.push(`gate3 (${inc.open_breaches} open SLO breaches)`);
    if (gate4 !== "GREEN") blockers.push(`gate4 (${pm.total} patterns, ${pm.qualified} qualified; need ≥30/5)`);
    recommendations.push({
      feature: "tier_router",
      verdict: "blocked",
      action: `Blocked on: ${blockers.join("; ")}. Unblock #1 at /admin/ai/labels (50 sessions × 30s/each). Unblock #4 by GitHub seed (MIT/Apache only) or organic traffic.`,
    });
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
    schema: {
      missing,
      message: missing.length === 0 ? "all tables present" : `${missing.length} table(s) missing — run pending migrations`,
    },
    volume: {
      verdict: volumeVerdict,
      total_5d: vol.total_5d,
      total_24h: vol.total_24h,
      completed_5d: vol.completed_5d,
      failed_5d: vol.failed_5d,
      classified_5d: vol.classified_5d,
      daily_avg: dailyAvg,
      note:
        volumeVerdict === "GREEN"
          ? "Boom story works at this volume."
          : volumeVerdict === "YELLOW"
            ? "Need ~5x more volume to viralize a public counter."
            : "Volume too low for public dashboard story; prioritize acquisition.",
    },
    tier_router: {
      gate1: { verdict: gate1, labeled: lab.labeled, agreement_pct: agreementPct },
      gate2: { verdict: gate2, n: lat.n, p50_ms: lat.p50, p95_ms: lat.p95, p99_ms: lat.p99 },
      gate3: { verdict: gate3, open_breaches: inc.open_breaches, metrics: inc.metrics },
      gate4: { verdict: gate4, total: pm.total, qualified: pm.qualified, distinct_projects: pm.distinct_projects, disabled: pm.disabled },
      gate5: { verdict: "N/A" as const, note: "manual approval doc — write when 1-4 are green" },
    },
    substrate_v2: {
      verdict: subVerdict,
      total: sub.total,
      both_ran: sub.both_ran,
      agreement_pct: subAgreementPct,
      v1pass_v2fail: sub.v1pass_v2fail,
      v1fail_v2pass: sub.v1fail_v2pass,
    },
    multi_agent_fanout: {
      verdict: fanReady,
      sessions_5d: fan.sessions_5d,
      with_fanout: fan.with_fanout,
      fanout_pct: fanoutPct,
      multi_hypothesis: fan.multi_hypothesis,
      avg_hypotheses: fan.avg_hypotheses,
    },
    recommendations,
  });
}
