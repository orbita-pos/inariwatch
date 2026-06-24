/**
 * GET /api/desktop/visual-report/[alertId]
 *
 * Returns the visual_reports row 1:1 with an alert, used by Inari Live's
 * `Cmd+\` AlertDetailPanel to render the screenshot + structured diagnosis
 * + evidence chips when the alert was created from a user-initiated bug
 * report (source_integrations includes 'user_report').
 *
 * Auth: same extension bearer token as /api/desktop/alert/[id].
 *
 * 404 when the alert exists but no visual_report row is attached (e.g.
 * the user opened a regular Sentry-sourced alert). 404 also when the
 * alert isn't in the bearer's project scope — we don't distinguish to
 * avoid leaking workspace membership.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, alerts, visualReports } from "@/lib/db";
import { eq } from "drizzle-orm";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";

export interface VisualReportDetailResponse {
  reportId:       string;
  alertId:        string;
  screenshotUrl:  string;
  description:    string;
  /**
   * 'pending' | 'triaging' | 'diagnosing' | 'critiquing' | 'completed'
   * | 'rejected' | 'need_info' | 'failed'
   */
  status:         string;
  confidence:     number | null;
  /** Structured diagnosis when status='completed' or 'need_info'. */
  diagnosis:      VisualDiagnosisShape | null;
  /** Diagnose model invoked. Useful for the desktop "Powered by Qwen…" footer. */
  modelDiagnose:  string | null;
  /** Pipeline wall-clock time (ms). */
  durationMs:     number | null;
  /** Cost in cents (server-side micro-accounting; informational in UI). */
  costCents:      number;
  /** Error string when status='failed'. */
  error:          string | null;
  /** ISO timestamps. */
  createdAt:      string;
  updatedAt:      string;
}

export interface VisualDiagnosisShape {
  root_cause: {
    file:         string;
    line:         number;
    function:     string;
    causal_chain: string[];
  };
  evidence: Array<{
    claim:  string;
    type:   string;
    source: string;
    quote:  string;
  }>;
  hypotheses_considered: Array<{
    hypothesis:       string;
    score:            number;
    rejected_because: string;
  }>;
  confidence:           number;
  unknowns:             string[];
  recommended_fix_hint: string;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ alertId: string }> }) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const { alertId } = await ctx.params;

  const [row] = await db
    .select({
      vr:  visualReports,
      pId: alerts.projectId,
      body: alerts.body,
    })
    .from(visualReports)
    .innerJoin(alerts, eq(alerts.id, visualReports.alertId))
    .where(eq(visualReports.alertId, alertId))
    .limit(1);

  if (!row || !auth.projectIds.includes(row.pId)) {
    return NextResponse.json({ error: "Visual report not found" }, { status: 404 });
  }

  const vr = row.vr;
  const bundle = vr.bundleJson as { userDescription?: string } | null;

  // Description preference: bundle.userDescription (set at SDK submit) →
  // alerts.body (also populated by the service from the same string) →
  // empty.
  const description = bundle?.userDescription ?? row.body ?? "";

  const payload: VisualReportDetailResponse = {
    reportId:      vr.id,
    alertId:       vr.alertId,
    screenshotUrl: vr.screenshotUrl,
    description,
    status:        vr.status,
    confidence:    vr.confidence ?? null,
    diagnosis:     (vr.diagnosis as VisualDiagnosisShape | null) ?? null,
    modelDiagnose: vr.modelDiagnose ?? null,
    durationMs:    vr.durationMs ?? null,
    costCents:     vr.costCents,
    error:         vr.error ?? null,
    createdAt:     vr.createdAt.toISOString(),
    updatedAt:     vr.updatedAt.toISOString(),
  };
  return NextResponse.json(payload);
}
