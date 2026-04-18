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
  startOrGetMultiEnvRun,
  getMultiEnvRunForAlert,
} from "@/lib/services/multi-env-coverage.service";
import { UUID_REGEX } from "@/lib/validation";
import { serverError } from "@/lib/api-error";

const MAX_WINDOW_DAYS = 90;
const MIN_WINDOW_DAYS = 1;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * VAR Gate 16 — Multi-Environment Coverage.
 *
 * GET  /api/alerts/:id/multi-env — poll status
 * POST /api/alerts/:id/multi-env — start/resume run
 *
 * POST body: { remediationId, windowDays?, thresholdHighPercent?, thresholdMediumPercent? }
 *
 * Auth: NextAuth + (project owner OR org member), same authz shape
 * as Gate 12/13/17 routes.
 *
 * Scoring is synchronous — the underlying query is cheap (O(alerts
 * in N-day window)) so no BullMQ job is needed. The response returns
 * 200 completed (or 202 when the row was newly created before scoring
 * kicked off; in practice we score inline so it's typically 200).
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

  const status = await getMultiEnvRunForAlert(alertId);
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

  let body: {
    remediationId?: unknown;
    windowDays?: unknown;
    thresholdHighPercent?: unknown;
    thresholdMediumPercent?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const remediationId = typeof body.remediationId === "string" ? body.remediationId : null;
  // M2: clamp windowDays to [1, 90] — matches drift-analysis contract.
  const windowDays =
    typeof body.windowDays === "number"
      ? Math.max(MIN_WINDOW_DAYS, Math.min(Math.floor(body.windowDays), MAX_WINDOW_DAYS))
      : undefined;
  // M2: both thresholds are percents, clamp to [0, 100].
  const thresholdHighPercent =
    typeof body.thresholdHighPercent === "number"
      ? Math.max(0, Math.min(body.thresholdHighPercent, 100))
      : undefined;
  const thresholdMediumPercent =
    typeof body.thresholdMediumPercent === "number"
      ? Math.max(0, Math.min(body.thresholdMediumPercent, 100))
      : undefined;
  if (!remediationId || !UUID_REGEX.test(remediationId)) {
    return NextResponse.json(
      { error: "remediationId required (uuid)" },
      { status: 400 },
    );
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
    const { runId, created, status } = await startOrGetMultiEnvRun({
      alertId,
      remediationId,
      fixCommitSha,
      windowDays,
      thresholdHighPercent,
      thresholdMediumPercent,
    });
    return NextResponse.json({ runId, run: status }, { status: created ? 202 : 200 });
  } catch (err) {
    return NextResponse.json(serverError(err, "multi-env-post"), { status: 500 });
  }
}

// ── Shared authz helper (same shape as Gate 12/13/17 routes) ─────────────

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
