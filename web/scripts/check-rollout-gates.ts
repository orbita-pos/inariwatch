/**
 * check-rollout-gates.ts — single-shot rollout readiness audit.
 *
 * Run:  cd web && npx tsx scripts/check-rollout-gates.ts
 *
 * Reads .env.local for DATABASE_URL. Read-only against prod Neon.
 *
 * Reports the state of the three canaries that gate "boom" features:
 *   1. Multi-agent fanout (FANOUT_CANARY_PCT) — currently 20% in deploy.yml
 *   2. Substrate v2 in-loop replay (SUBSTRATE_V2_GATE) — currently 5% drain-only
 *   3. Tier-router shadow→live (TIER_ROUTER_MODE) — currently shadow
 *
 * For each, prints:
 *   - Current observed activity (last 5d)
 *   - Whether the 5 promotion gates from web/docs/tier-router-rollout.md are GREEN/RED
 *   - The exact `kamal env push` command to ramp it (or what's blocking)
 *
 * Exit code: always 0 (informational). Never mutates data.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { sql } from "drizzle-orm";

type Verdict = "GREEN" | "YELLOW" | "RED" | "N/A";

function pad(n: string | number, w: number) {
  const s = String(n);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function color(v: Verdict): string {
  switch (v) {
    case "GREEN":
      return "\x1b[32m✓\x1b[0m";
    case "YELLOW":
      return "\x1b[33m●\x1b[0m";
    case "RED":
      return "\x1b[31m✗\x1b[0m";
    case "N/A":
      return "\x1b[90m–\x1b[0m";
  }
}

async function tableExists(db: any, name: string): Promise<boolean> {
  try {
    const r = (await db.execute(sql`
      SELECT to_regclass(${name})::text AS reg
    `)) as unknown as Array<{ reg: string | null }>;
    return r[0]?.reg !== null;
  } catch {
    return false;
  }
}

async function safeExec<T>(db: any, label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    console.log(`  \x1b[90m(${label}: ${e?.message ?? "query failed"})\x1b[0m`);
    return fallback;
  }
}

async function main() {
  const { db } = await import("../lib/db");

  console.log("\n=== InariWatch Rollout Gates Audit ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`DB:   ${process.env.DATABASE_URL?.split("@")[1]?.split("/")[0] ?? "(unknown)"}\n`);

  // ── 0. Schema sanity — which tables actually exist? ─────────────────────────
  const need = [
    "remediation_sessions",
    "ai_usage_logs",
    "pattern_memory",
    "tier_router_labels",
    "slo_events",
    "substrate_replay_comparisons",
  ];
  const present: Record<string, boolean> = {};
  for (const t of need) present[t] = await tableExists(db, t);
  const missing = need.filter(t => !present[t]);
  if (missing.length > 0) {
    console.log("⚠  Missing tables in this database:");
    for (const t of missing) console.log(`     - ${t}`);
    console.log("   → migrations are not at HEAD. Recent migrations 0069-0073 add tier-router/SLO/substrate-v2 telemetry.");
    console.log("   → run pending migrations OR confirm this is the right DB.\n");
  }

  // ── 1. Volume baseline ──────────────────────────────────────────────────────
  const volRows = (await db.execute(sql`
    SELECT
      COUNT(*)::int                                            AS total_5d,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS total_24h,
      COUNT(*) FILTER (WHERE status = 'completed')::int        AS completed_5d,
      COUNT(*) FILTER (WHERE status = 'failed')::int           AS failed_5d,
      COUNT(*) FILTER (WHERE tier_used IS NOT NULL)::int       AS classified_5d
    FROM remediation_sessions
    WHERE created_at > NOW() - INTERVAL '5 days'
  `)) as unknown as Array<{
    total_5d: number; total_24h: number; completed_5d: number;
    failed_5d: number; classified_5d: number;
  }>;
  const vol = volRows[0] ?? { total_5d: 0, total_24h: 0, completed_5d: 0, failed_5d: 0, classified_5d: 0 };

  console.log("── Volume baseline (last 5 days) ──");
  console.log(`  Total remediations:  ${vol.total_5d}  (last 24h: ${vol.total_24h})`);
  console.log(`  Completed:           ${vol.completed_5d}`);
  console.log(`  Failed:              ${vol.failed_5d}`);
  console.log(`  Classified by tier-router (shadow):  ${vol.classified_5d}`);
  const dailyAvg = vol.total_5d / 5;
  let volVerdict: Verdict = "RED";
  if (dailyAvg >= 50) volVerdict = "GREEN";
  else if (dailyAvg >= 10) volVerdict = "YELLOW";
  console.log(`  Daily avg: ${dailyAvg.toFixed(1)}/day  ${color(volVerdict)} ${
    volVerdict === "GREEN" ? "(boom story works at this volume)" :
    volVerdict === "YELLOW" ? "(boom story needs ~5x more volume to viralize)" :
    "(volume too low for public dashboard story)"
  }\n`);

  // ── 2. Tier-router gates ────────────────────────────────────────────────────
  console.log("── Tier-router shadow→live (5 gates from rollout playbook) ──");

  // Gate #1 — human agreement on labels
  const labelRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS labeled,
           COUNT(*) FILTER (
             WHERE l.human_tier = s.tier_used
           )::int AS agreed
    FROM tier_router_labels l
    JOIN remediation_sessions s ON s.id = l.session_id
    WHERE s.tier_used IS NOT NULL
  `)) as unknown as Array<{ labeled: number; agreed: number }>;
  const lab = labelRows[0] ?? { labeled: 0, agreed: 0 };
  const agreementPct = lab.labeled > 0 ? (lab.agreed * 100) / lab.labeled : 0;
  let g1: Verdict = "RED";
  if (lab.labeled >= 50 && agreementPct >= 90) g1 = "GREEN";
  else if (lab.labeled >= 50 && agreementPct >= 80) g1 = "YELLOW";
  console.log(`  ${color(g1)} Gate #1 (≥50 labels, ≥90% agreement): ${lab.labeled} labels, ${agreementPct.toFixed(1)}% agreement`);

  // Gate #2 — classifier latency p95
  const latRows = (await db.execute(sql`
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
  const lat = latRows[0] ?? { n: 0, p50: 0, p95: 0, p99: 0 };
  let g2: Verdict = "N/A";
  if (lat.n >= 30) {
    g2 = lat.p95 < 200 ? "GREEN" : lat.p95 < 400 ? "YELLOW" : "RED";
  }
  console.log(`  ${color(g2)} Gate #2 (classifier p95 < 200ms):     n=${lat.n}, p50=${lat.p50}ms, p95=${lat.p95}ms, p99=${lat.p99}ms`);

  // Gate #3 — zero critical incidents attributed to router
  const inc = present["slo_events"]
    ? await safeExec(db, "gate#3", async () => {
        const rows = (await db.execute(sql`
          SELECT COUNT(*)::int AS open_breaches,
                 STRING_AGG(DISTINCT tier || ':' || metric, ', ') AS metrics
          FROM slo_events
          WHERE resolved_at IS NULL
            AND created_at > NOW() - INTERVAL '5 days'
        `)) as unknown as Array<{ open_breaches: number; metrics: string | null }>;
        return rows[0] ?? { open_breaches: 0, metrics: null };
      }, { open_breaches: 0, metrics: null as string | null })
    : { open_breaches: 0, metrics: null as string | null };
  const g3: Verdict = !present["slo_events"] ? "N/A" : (inc.open_breaches === 0 ? "GREEN" : "YELLOW");
  console.log(`  ${color(g3)} Gate #3 (zero open SLO breaches):     ${present["slo_events"] ? inc.open_breaches : "table missing"}${inc.metrics ? ` — ${inc.metrics}` : ""}`);

  // Gate #4 — pattern memory health
  const pmRows = (await db.execute(sql`
    SELECT
      COUNT(*)::int                                               AS total,
      COUNT(*) FILTER (WHERE success_count >= 3)::int             AS qualified,
      COUNT(*) FILTER (WHERE disabled_at IS NOT NULL)::int        AS disabled,
      COUNT(DISTINCT project_id)::int                             AS distinct_projects
    FROM pattern_memory
  `)) as unknown as Array<{ total: number; qualified: number; disabled: number; distinct_projects: number }>;
  const pm = pmRows[0] ?? { total: 0, qualified: 0, disabled: 0, distinct_projects: 0 };
  let g4: Verdict = "RED";
  if (pm.total >= 30 && pm.qualified >= 5) g4 = "GREEN";
  else if (pm.total >= 15 && pm.qualified >= 2) g4 = "YELLOW";
  console.log(`  ${color(g4)} Gate #4 (≥30 patterns, ≥5 qualified): total=${pm.total}, qualified=${pm.qualified}, projects=${pm.distinct_projects}, disabled=${pm.disabled}`);

  // Gate #5 — approval doc — manual, not query-able
  console.log(`  ${color("N/A")} Gate #5 (approval sign-off):          manual — write rollout doc when 1-4 are green`);

  // ── 3. Substrate v2 canary ──────────────────────────────────────────────────
  console.log("\n── Substrate v2 in-loop canary (5% drain-only → 100% blocking) ──");
  const sub = present["substrate_replay_comparisons"]
    ? await safeExec(db, "substrate-v2", async () => {
        const rows = (await db.execute(sql`
          SELECT
            COUNT(*)::int                                       AS total,
            COUNT(*) FILTER (WHERE v1_passed IS NOT NULL AND v2_passed IS NOT NULL)::int AS both_ran,
            COUNT(*) FILTER (WHERE v1_passed = v2_passed)::int  AS agreement,
            COUNT(*) FILTER (WHERE v1_passed = true  AND v2_passed = false)::int AS v1pass_v2fail,
            COUNT(*) FILTER (WHERE v1_passed = false AND v2_passed = true)::int  AS v1fail_v2pass
          FROM substrate_replay_comparisons
          WHERE created_at > NOW() - INTERVAL '5 days'
        `)) as unknown as Array<{
          total: number; both_ran: number; agreement: number;
          v1pass_v2fail: number; v1fail_v2pass: number;
        }>;
        return rows[0] ?? { total: 0, both_ran: 0, agreement: 0, v1pass_v2fail: 0, v1fail_v2pass: 0 };
      }, { total: 0, both_ran: 0, agreement: 0, v1pass_v2fail: 0, v1fail_v2pass: 0 })
    : { total: 0, both_ran: 0, agreement: 0, v1pass_v2fail: 0, v1fail_v2pass: 0 };
  const agreementSubPct = sub.both_ran > 0 ? (sub.agreement * 100) / sub.both_ran : 0;
  let subVerdict: Verdict = "RED";
  if (!present["substrate_replay_comparisons"]) subVerdict = "N/A";
  else if (sub.both_ran >= 30 && agreementSubPct >= 95) subVerdict = "GREEN";
  else if (sub.both_ran >= 10 && agreementSubPct >= 85) subVerdict = "YELLOW";
  else if (sub.both_ran === 0) subVerdict = "N/A";
  console.log(`  ${color(subVerdict)} v1 vs v2 agreement (need ≥95%):   ${agreementSubPct.toFixed(1)}% (n=${sub.both_ran})`);
  console.log(`     v1 pass / v2 fail: ${sub.v1pass_v2fail}   v1 fail / v2 pass: ${sub.v1fail_v2pass}`);

  // ── 4. Multi-agent fanout activity ──────────────────────────────────────────
  console.log("\n── Multi-agent fanout (currently 20% canary) ──");
  const fanRows = (await db.execute(sql`
    SELECT
      COUNT(*)::int                                       AS sessions_5d,
      COUNT(*) FILTER (WHERE hypothesis_count IS NOT NULL AND hypothesis_count > 0)::int AS with_fanout,
      COUNT(*) FILTER (WHERE hypothesis_count > 1)::int   AS multi_hypothesis,
      AVG(hypothesis_count) FILTER (WHERE hypothesis_count > 0)::float AS avg_hypotheses
    FROM remediation_sessions
    WHERE created_at > NOW() - INTERVAL '5 days'
  `)) as unknown as Array<{
    sessions_5d: number; with_fanout: number; multi_hypothesis: number; avg_hypotheses: number | null;
  }>;
  const fan = fanRows[0] ?? { sessions_5d: 0, with_fanout: 0, multi_hypothesis: 0, avg_hypotheses: null };
  const fanoutPct = fan.sessions_5d > 0 ? (fan.with_fanout * 100) / fan.sessions_5d : 0;
  console.log(`  Sessions w/ fanout:        ${fan.with_fanout} / ${fan.sessions_5d} (${fanoutPct.toFixed(1)}%)`);
  console.log(`  Multi-hypothesis sessions: ${fan.multi_hypothesis}`);
  console.log(`  Avg hypotheses per fanout: ${fan.avg_hypotheses?.toFixed(2) ?? "—"}`);
  const fanReady = fan.with_fanout >= 10 && fan.sessions_5d > 0;
  console.log(`  ${color(fanReady ? "GREEN" : "YELLOW")} Fanout health:                ${fanReady ? "running, safe to ramp" : "low signal — soak more before ramp"}`);

  // ── 5. Recommended next actions ─────────────────────────────────────────────
  console.log("\n── RECOMMENDED NEXT ACTIONS (in order) ──\n");

  const actions: string[] = [];

  // Fanout ramp — lowest-risk, biggest visible win
  if (fanReady) {
    actions.push(
      `1. Multi-agent fanout 20% → 50%:\n` +
      `     cd web && kamal env push -d production -e FANOUT_CANARY_PCT=50\n` +
      `   Soak 24h, then ramp to 100% if fanout success rate ≥ baseline.`
    );
  } else {
    actions.push(
      `1. Multi-agent fanout: NOT READY to ramp (need ≥10 fanout sessions in 5d, have ${fan.with_fanout}).\n` +
      `   Either wait for more traffic, or check that MULTI_AGENT_FANOUT=true is actually firing.`
    );
  }

  // Substrate v2 ramp
  if (subVerdict === "GREEN") {
    actions.push(
      `2. Substrate v2 5% drain → 100% drain (next step: enable blocking):\n` +
      `   First: bump canary % via the in-loop router (no env var change — see substrate-replay.ts:622).\n` +
      `   Then: rsync substrate-v2-replay binary to Hetzner if not present, flip blocking mode.`
    );
  } else if (subVerdict === "N/A") {
    actions.push(
      `2. Substrate v2: no comparison rows yet. Verify SUBSTRATE_V2_GATE=true is actually firing,\n` +
      `   and that the /v2/replay endpoint binary is rsync'd to /usr/local/bin/substrate-v2-replay on Hetzner.\n` +
      `   Smoke test:  curl https://api.staging.inariwatch.com/v2/replay (expect non-503).`
    );
  } else {
    actions.push(
      `2. Substrate v2: agreement ${agreementSubPct.toFixed(1)}% (need ≥95%). Investigate v1/v2 divergence\n` +
      `   in the substrate_replay_comparisons table before ramping further. /admin/ops widget has detail.`
    );
  }

  // Tier router promotion
  const tierGates = [g1, g2, g3, g4];
  const greenCount = tierGates.filter(g => g === "GREEN").length;
  const redCount = tierGates.filter(g => g === "RED").length;
  if (redCount === 0 && greenCount >= 3) {
    actions.push(
      `3. Tier-router shadow → live (canary 10%):\n` +
      `     write approval doc → cd web && kamal env push -d production -e TIER_ROUTER_MODE=live\n` +
      `   Roll back: TIER_ROUTER_MODE=shadow + kamal env push (~30s, no rebuild).`
    );
  } else {
    const blockers: string[] = [];
    if (g1 !== "GREEN") blockers.push(`#1 (need ≥50 labels at 90% agreement; have ${lab.labeled} at ${agreementPct.toFixed(1)}%)`);
    if (g2 !== "GREEN" && g2 !== "N/A") blockers.push(`#2 (latency p95 ${lat.p95}ms vs target <200ms)`);
    if (g3 !== "GREEN") blockers.push(`#3 (${inc.open_breaches} open SLO breaches)`);
    if (g4 !== "GREEN") blockers.push(`#4 (pattern memory: ${pm.total} total, ${pm.qualified} qualified — need ≥30 / ≥5)`);
    actions.push(
      `3. Tier-router: BLOCKED on gate(s):\n` +
      blockers.map(b => `     - ${b}`).join("\n") +
      `\n   To unblock #1: visit /admin/ai/labels and label 50 sessions.\n` +
      `   To unblock #4: write seed-pattern-memory-from-github.ts (GitHub Top 200 repos, MIT/Apache/BSD only).`
    );
  }

  // Print
  for (const a of actions) console.log(a + "\n");

  // ── 6. Summary table ────────────────────────────────────────────────────────
  console.log("── Quick summary ──");
  console.log(`  ${pad("Gate", 32)} ${pad("Status", 8)} Detail`);
  console.log(`  ${"-".repeat(32)} ${"-".repeat(8)} ${"-".repeat(40)}`);
  console.log(`  ${pad("Volume (≥50/day for boom)", 32)} ${pad(volVerdict, 8)} ${dailyAvg.toFixed(1)}/day`);
  console.log(`  ${pad("Tier #1 — human agreement", 32)} ${pad(g1, 8)} ${lab.labeled} labels, ${agreementPct.toFixed(0)}%`);
  console.log(`  ${pad("Tier #2 — classifier p95", 32)} ${pad(g2, 8)} ${lat.p95}ms`);
  console.log(`  ${pad("Tier #3 — open SLO breaches", 32)} ${pad(g3, 8)} ${inc.open_breaches}`);
  console.log(`  ${pad("Tier #4 — pattern memory", 32)} ${pad(g4, 8)} ${pm.total} total, ${pm.qualified} qualified`);
  console.log(`  ${pad("Substrate v2 agreement", 32)} ${pad(subVerdict, 8)} ${agreementSubPct.toFixed(1)}% (n=${sub.both_ran})`);
  console.log(`  ${pad("Fanout activity", 32)} ${pad(fanReady ? "GREEN" : "YELLOW", 8)} ${fan.with_fanout} sessions w/ fanout`);
  console.log("");

  process.exit(0);
}

main().catch(err => {
  console.error("\nERROR:", err);
  process.exit(1);
});
