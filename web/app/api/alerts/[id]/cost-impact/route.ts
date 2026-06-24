import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  alerts,
  remediationSessions,
  projects,
  organizations,
  organizationMembers,
} from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import {
  startOrGetCostImpact,
  getCostImpactForAlert,
} from "@/lib/services/cost-impact.service";
import { UUID_REGEX } from "@/lib/validation";
import { serverError } from "@/lib/api-error";

const MAX_THRESHOLD_USD = 10_000;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * VAR Gate 14 — Cost Impact.
 *
 * GET  /api/alerts/:id/cost-impact — poll status
 * POST /api/alerts/:id/cost-impact — start/resume run
 *
 * POST body: { remediationId, thresholdUsd? }
 *
 * Auth: NextAuth + (project owner OR org member), same authz as Gate
 * 12/13/16/17 routes.
 *
 * Scoring is synchronous — single SUM/GROUP BY over ai_usage_logs.
 */

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: alertId } = await params;
  if (!UUID_REGEX.test(alertId)) {
    return NextResponse.json({ error: "Invalid alertId" }, { status: 400 });
  }

  if (!(await authorize(alertId, userId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = await getCostImpactForAlert(alertId);
  return NextResponse.json({ run: status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: alertId } = await params;
  if (!UUID_REGEX.test(alertId)) {
    return NextResponse.json({ error: "Invalid alertId" }, { status: 400 });
  }

  let body: { remediationId?: unknown; thresholdUsd?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const remediationId = typeof body.remediationId === "string" ? body.remediationId : null;
  // M2: thresholdUsd must be non-negative and within a sane ceiling — a
  // $10M threshold serves no purpose and prevents numeric-edge cases
  // (Infinity, huge floats) from flowing into drizzle numeric columns.
  const thresholdUsd =
    typeof body.thresholdUsd === "number" && Number.isFinite(body.thresholdUsd)
      ? Math.max(0, Math.min(body.thresholdUsd, MAX_THRESHOLD_USD))
      : undefined;
  if (!remediationId || !UUID_REGEX.test(remediationId)) {
    return NextResponse.json({ error: "remediationId required (uuid)" }, { status: 400 });
  }

  if (!(await authorize(alertId, userId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [row] = await db
    .select({
      remediationAlertId: remediationSessions.alertId,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      branch: remediationSessions.branch,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.id, remediationId))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Remediation not found" }, { status: 404 });
  }
  if (row.remediationAlertId !== alertId) {
    return NextResponse.json(
      { error: "Remediation does not belong to this alert" },
      { status: 400 },
    );
  }

  const fixCommitSha = row.mergedCommitSha ?? `branch:${row.branch ?? remediationId}`;

  try {
    const { runId, created, status } = await startOrGetCostImpact({
      alertId,
      remediationId,
      fixCommitSha,
      thresholdUsd,
    });
    return NextResponse.json({ runId, run: status }, { status: created ? 202 : 200 });
  } catch (err) {
    return NextResponse.json(serverError(err, "cost-impact-post"), { status: 500 });
  }
}

async function authorize(alertId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      ownerId: projects.userId,
      organizationId: projects.organizationId,
    })
    .from(alerts)
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .where(eq(alerts.id, alertId))
    .limit(1);
  if (!row) return false;
  if (row.ownerId === userId) return true;
  if (!row.organizationId) return false;

  const [access] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(organizations.id, row.organizationId),
        or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
      ),
    )
    .limit(1);
  return !!access;
}
