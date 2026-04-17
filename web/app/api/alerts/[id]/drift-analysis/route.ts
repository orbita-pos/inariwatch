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
  startOrGetDriftRun,
  getDriftRunForAlert,
} from "@/lib/services/behavioral-drift.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * VAR Gate 13 — Behavioral Drift.
 *
 * GET  /api/alerts/:id/drift-analysis — poll status
 * POST /api/alerts/:id/drift-analysis — start/resume run
 *
 * POST body: { remediationId, windowDays?, thresholdDriftedPercent? }
 *
 * Auth: NextAuth + (project owner OR org member) — same authz shape as
 * Gate 12/17 routes.
 */

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: alertId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(alertId)) {
    return NextResponse.json({ error: "Invalid alertId" }, { status: 400 });
  }

  if (!(await authorize(alertId, userId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = await getDriftRunForAlert(alertId);
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
  if (!/^[0-9a-f-]{36}$/i.test(alertId)) {
    return NextResponse.json({ error: "Invalid alertId" }, { status: 400 });
  }

  let body: {
    remediationId?: unknown;
    windowDays?: unknown;
    thresholdDriftedPercent?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const remediationId =
    typeof body.remediationId === "string" ? body.remediationId : null;
  const windowDays =
    typeof body.windowDays === "number" ? body.windowDays : undefined;
  const thresholdDriftedPercent =
    typeof body.thresholdDriftedPercent === "number"
      ? body.thresholdDriftedPercent
      : undefined;
  if (!remediationId || !/^[0-9a-f-]{36}$/i.test(remediationId)) {
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

  const fixCommitSha =
    row.mergedCommitSha ?? `branch:${row.branch ?? remediationId}`;

  try {
    const { runId, created, status } = await startOrGetDriftRun({
      alertId,
      remediationId,
      fixCommitSha,
      windowDays,
      thresholdDriftedPercent,
    });
    return NextResponse.json(
      { runId, run: status },
      { status: created ? 202 : 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── Shared authz helper — same shape as Gate 12/17 routes ────────────────

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
