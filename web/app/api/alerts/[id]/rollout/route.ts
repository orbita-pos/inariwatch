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
  startOrGetRollout,
  getRolloutForAlert,
  advanceStage,
  rollback,
} from "@/lib/services/rollout.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * VAR Progressive Rollout — Q2 Week 12.
 *
 * GET  /api/alerts/:id/rollout                     — poll status
 * POST /api/alerts/:id/rollout                     — start (idempotent)
 * POST /api/alerts/:id/rollout  { action: "advance" }   — advance stage
 * POST /api/alerts/:id/rollout  { action: "rollback", reason } — rollback
 *
 * Auth: NextAuth + (project owner OR org member), same shape as
 * Gate 12/13/14/16/17.
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

  const status = await getRolloutForAlert(alertId);
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
    action?: unknown;
    remediationId?: unknown;
    runId?: unknown;
    reason?: unknown;
    rollbackPrUrl?: unknown;
    autoRollbackEnabled?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "start";

  if (!(await authorize(alertId, userId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    if (action === "advance") {
      const runId = typeof body.runId === "string" ? body.runId : null;
      if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
        return NextResponse.json({ error: "runId required (uuid)" }, { status: 400 });
      }
      const status = await advanceStage({ runId, triggeredBy: `user:${userId}` });
      return NextResponse.json({ run: status });
    }

    if (action === "rollback") {
      const runId = typeof body.runId === "string" ? body.runId : null;
      const reason = typeof body.reason === "string" ? body.reason : null;
      const rollbackPrUrl =
        typeof body.rollbackPrUrl === "string" ? body.rollbackPrUrl : undefined;
      if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
        return NextResponse.json({ error: "runId required (uuid)" }, { status: 400 });
      }
      if (!reason || reason.length < 3) {
        return NextResponse.json({ error: "reason required" }, { status: 400 });
      }
      const status = await rollback({
        runId,
        triggeredBy: `user:${userId}`,
        reason,
        rollbackPrUrl,
      });
      return NextResponse.json({ run: status });
    }

    // action === "start" (default)
    const remediationId = typeof body.remediationId === "string" ? body.remediationId : null;
    const autoRollbackEnabled =
      typeof body.autoRollbackEnabled === "boolean" ? body.autoRollbackEnabled : undefined;
    if (!remediationId || !/^[0-9a-f-]{36}$/i.test(remediationId)) {
      return NextResponse.json({ error: "remediationId required (uuid)" }, { status: 400 });
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

    const { runId, created, status } = await startOrGetRollout({
      alertId,
      remediationId,
      fixCommitSha,
      autoRollbackEnabled,
    });
    return NextResponse.json({ runId, run: status }, { status: created ? 202 : 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
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
