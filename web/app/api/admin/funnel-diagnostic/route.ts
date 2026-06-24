/**
 * GET /api/admin/funnel-diagnostic — answer "where does the funnel break?".
 *
 * Auth: Bearer CRON_SECRET (timing-safe).
 *
 * Returns a stage-by-stage signup → setup → alert → remediation breakdown
 * over the last 30 / 7 / 1 days, plus a focused look at demo@inariwatch.com
 * (the public demo account that paid ads land on).
 *
 * Read-only. Idempotent.
 */

import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const CRON_SECRET = process.env.CRON_SECRET;
const DEMO_EMAIL = "demo@inariwatch.com";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    return { ...fallback, _error: e?.message?.slice(0, 200) ?? "query failed" } as any;
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

  // ── Stage A: signup funnel ──────────────────────────────────────────────────
  const signupFunnel = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        CAST(COUNT(*) AS integer) AS users_total,
        CAST(COUNT(*) FILTER (WHERE email_verified_at IS NOT NULL) AS integer) AS users_verified_total,
        CAST(COUNT(*) FILTER (WHERE plan != 'free') AS integer) AS users_paid_total,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS integer) AS users_30d,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days' AND email_verified_at IS NOT NULL) AS integer) AS users_verified_30d,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS integer) AS users_7d,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND email_verified_at IS NOT NULL) AS integer) AS users_verified_7d,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS integer) AS users_24h
      FROM users
    `)) as unknown as Array<Record<string, number>>;
    return r[0] ?? {};
  }, {} as Record<string, number>);

  // ── Stage B: project setup ──────────────────────────────────────────────────
  const projectFunnel = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        CAST(COUNT(*) AS integer) AS projects_total,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS integer) AS projects_30d,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS integer) AS projects_7d,
        CAST(COUNT(*) FILTER (WHERE default_repo IS NOT NULL) AS integer) AS projects_with_repo,
        CAST(COUNT(DISTINCT user_id) AS integer) AS users_with_at_least_one_project
      FROM projects
    `)) as unknown as Array<Record<string, number>>;
    return r[0] ?? {};
  }, {} as Record<string, number>);

  // ── Stage C: integrations connected ─────────────────────────────────────────
  const integrationFunnel = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        CAST(COUNT(*) AS integer) AS integrations_total,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS integer) AS integrations_30d,
        CAST(COUNT(DISTINCT project_id) AS integer) AS projects_with_integration,
        CAST(COUNT(DISTINCT type) AS integer) AS distinct_types
      FROM project_integrations
    `)) as unknown as Array<Record<string, number>>;
    return r[0] ?? {};
  }, {} as Record<string, number>);

  const integrationTypes = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT type, CAST(COUNT(*) AS integer) AS count
      FROM project_integrations
      GROUP BY type
      ORDER BY count DESC
      LIMIT 20
    `)) as unknown as Array<{ type: string; count: number }>;
    return r;
  }, [] as Array<{ type: string; count: number }>);

  // ── Stage D: alerts received ────────────────────────────────────────────────
  const alertFunnel = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        CAST(COUNT(*) AS integer) AS alerts_total,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS integer) AS alerts_30d,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS integer) AS alerts_7d,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS integer) AS alerts_24h,
        CAST(COUNT(DISTINCT project_id) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS integer) AS projects_with_alerts_7d
      FROM alerts
    `)) as unknown as Array<Record<string, number>>;
    return r[0] ?? {};
  }, {} as Record<string, number>);

  const alertSources = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        COALESCE(source, '<null>') AS source,
        CAST(COUNT(*) AS integer) AS count,
        MAX(created_at)::text AS last_seen
      FROM alerts
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY source
      ORDER BY count DESC
      LIMIT 20
    `)) as unknown as Array<{ source: string; count: number; last_seen: string }>;
    return r;
  }, [] as Array<{ source: string; count: number; last_seen: string }>);

  // ── Stage E: remediations triggered ─────────────────────────────────────────
  const remediationFunnel = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        CAST(COUNT(*) AS integer) AS remediations_total,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS integer) AS remediations_30d,
        CAST(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS integer) AS remediations_7d,
        MAX(created_at)::text AS latest_remediation_at
      FROM remediation_sessions
    `)) as unknown as Array<{ remediations_total: number; remediations_30d: number; remediations_7d: number; latest_remediation_at: string | null }>;
    return r[0] ?? { remediations_total: 0, remediations_30d: 0, remediations_7d: 0, latest_remediation_at: null };
  }, { remediations_total: 0, remediations_30d: 0, remediations_7d: 0, latest_remediation_at: null });

  // ── auto-remediate adoption ─────────────────────────────────────────────────
  const autoRemediate = await safe(async () => {
    const r = (await db.execute(sql`
      SELECT
        CAST(COUNT(*) AS integer) AS projects_total,
        CAST(COUNT(*) FILTER (
          WHERE auto_merge_config IS NOT NULL
          AND (auto_merge_config->>'enabled')::boolean = true
        ) AS integer) AS auto_merge_enabled,
        CAST(COUNT(*) FILTER (
          WHERE auto_merge_config IS NOT NULL
          AND (auto_merge_config->>'autoRemediate')::boolean = true
        ) AS integer) AS auto_remediate_enabled
      FROM projects
    `)) as unknown as Array<Record<string, number>>;
    return r[0] ?? {};
  }, {} as Record<string, number>);

  // ── Demo user activity ──────────────────────────────────────────────────────
  const demoActivity = await safe(async () => {
    const userRows = (await db.execute(sql`
      SELECT id, email, created_at::text AS created_at, email_verified_at::text AS email_verified_at
      FROM users
      WHERE email = ${DEMO_EMAIL}
      LIMIT 1
    `)) as unknown as Array<{ id: string; email: string; created_at: string; email_verified_at: string | null }>;
    const u = userRows[0];
    if (!u) return { exists: false } as any;

    const projectRows = (await db.execute(sql`
      SELECT CAST(COUNT(*) AS integer) AS n
      FROM projects WHERE user_id = ${u.id}::uuid
    `)) as unknown as Array<{ n: number }>;

    const alertRows = (await db.execute(sql`
      SELECT
        CAST(COUNT(*) AS integer) AS total,
        CAST(COUNT(*) FILTER (WHERE a.created_at > NOW() - INTERVAL '30 days') AS integer) AS d30,
        CAST(COUNT(*) FILTER (WHERE a.created_at > NOW() - INTERVAL '7 days') AS integer) AS d7,
        MAX(a.created_at)::text AS latest
      FROM alerts a
      JOIN projects p ON p.id = a.project_id
      WHERE p.user_id = ${u.id}::uuid
    `)) as unknown as Array<{ total: number; d30: number; d7: number; latest: string | null }>;

    const remRows = (await db.execute(sql`
      SELECT CAST(COUNT(*) AS integer) AS total, MAX(created_at)::text AS latest
      FROM remediation_sessions
      WHERE user_id = ${u.id}::uuid
    `)) as unknown as Array<{ total: number; latest: string | null }>;

    return {
      exists: true,
      user_id: u.id,
      created_at: u.created_at,
      email_verified_at: u.email_verified_at,
      projects: projectRows[0]?.n ?? 0,
      alerts: alertRows[0] ?? { total: 0, d30: 0, d7: 0, latest: null },
      remediations: remRows[0] ?? { total: 0, latest: null },
    };
  }, { exists: false } as any);

  // ── Diagnosis: where does the funnel break? ─────────────────────────────────
  const diagnosis: string[] = [];

  const u30 = (signupFunnel as any).users_30d ?? 0;
  const v30 = (signupFunnel as any).users_verified_30d ?? 0;
  const p30 = (projectFunnel as any).projects_30d ?? 0;
  const i30 = (integrationFunnel as any).integrations_30d ?? 0;
  const a30 = (alertFunnel as any).alerts_30d ?? 0;
  const r30 = remediationFunnel.remediations_30d ?? 0;

  if (u30 === 0) {
    diagnosis.push("STAGE_1_NO_SIGNUPS: 0 signups in 30 days. Paid ads aren't converting to account creation. Check ad → landing → signup form analytics.");
  } else if (v30 / Math.max(u30, 1) < 0.5) {
    diagnosis.push(`STAGE_2_VERIFY_LEAK: only ${v30}/${u30} signups verify email in 30d (${((v30/u30)*100).toFixed(0)}%). Email deliverability or verify UX broken.`);
  }

  if (u30 > 0 && p30 === 0) {
    diagnosis.push(`STAGE_3_NO_PROJECT: ${u30} signups but 0 projects in 30d. Users sign up but don't create a project — onboarding flow broken.`);
  } else if (p30 > 0 && p30 / Math.max(v30, 1) < 0.5) {
    diagnosis.push(`STAGE_3_PROJECT_LEAK: ${p30}/${v30} verified users create a project (${((p30/Math.max(v30,1))*100).toFixed(0)}%). Onboarding too long or unclear.`);
  }

  if (p30 > 0 && i30 === 0) {
    diagnosis.push(`STAGE_4_NO_INTEGRATION: ${p30} projects but 0 integrations connected in 30d. Users create projects but never wire Sentry/Vercel/GitHub/capture. Integration UI is the leak.`);
  }

  if (i30 > 0 && a30 === 0) {
    diagnosis.push(`STAGE_5_NO_ALERTS: ${i30} integrations connected but 0 alerts received in 30d. Webhooks not firing OR capture SDK not running OR all production is healthy.`);
  }

  if (a30 > 0 && r30 === 0) {
    const auto = (autoRemediate as any).auto_remediate_enabled ?? 0;
    diagnosis.push(`STAGE_6_NO_REMEDIATION: ${a30} alerts received but 0 remediations triggered in 30d. autoRemediate=true on only ${auto} projects. Either users don't click Fix-It OR autoRemediate not activated by default.`);
  }

  if (diagnosis.length === 0 && r30 > 0) {
    diagnosis.push(`PIPELINE_HEALTHY: ${r30} remediations in 30d. Activate features now.`);
  } else if (diagnosis.length === 0) {
    diagnosis.push("DATA_AMBIGUOUS: no obvious funnel break. Drill into specific stages.");
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
    funnel: {
      stage1_signups: signupFunnel,
      stage2_projects: projectFunnel,
      stage3_integrations: { ...integrationFunnel, by_type: integrationTypes },
      stage4_alerts: { ...alertFunnel, by_source: alertSources },
      stage5_remediations: remediationFunnel,
      stage6_auto_remediate: autoRemediate,
    },
    demo_user: demoActivity,
    diagnosis,
  });
}
