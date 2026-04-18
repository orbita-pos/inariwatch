import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  alerts,
  remediationSessions,
  rolloutRuns,
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
import { isSafeUrl } from "@/lib/services/url-validation";
import { UUID_REGEX } from "@/lib/validation";
import { serverError } from "@/lib/api-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REASON_LENGTH = 500;

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
 *
 * Security: advance / rollback actions bind `body.runId` to the
 * authorized `alertId` before calling the service — prevents cross-
 * tenant mutation of another org's rollout state machine.
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
  if (!UUID_REGEX.test(alertId)) {
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
      if (!runId || !UUID_REGEX.test(runId)) {
        return NextResponse.json({ error: "runId required (uuid)" }, { status: 400 });
      }
      // H1: the caller is authorized against alertId but supplies runId
      // freely — bind them together before mutating state.
      const ownership = await assertRunBelongsToAlert(runId, alertId);
      if (ownership !== null) return ownership;

      const status = await advanceStage({ runId, triggeredBy: `user:${userId}` });
      return NextResponse.json({ run: status });
    }

    if (action === "rollback") {
      const runId = typeof body.runId === "string" ? body.runId : null;
      const reason =
        typeof body.reason === "string"
          ? body.reason.slice(0, MAX_REASON_LENGTH)
          : null;
      const rawRollbackPrUrl =
        typeof body.rollbackPrUrl === "string" ? body.rollbackPrUrl : undefined;
      if (!runId || !UUID_REGEX.test(runId)) {
        return NextResponse.json({ error: "runId required (uuid)" }, { status: 400 });
      }
      if (!reason || reason.length < 3) {
        return NextResponse.json(
          { error: `reason required (3-${MAX_REASON_LENGTH} chars)` },
          { status: 400 },
        );
      }
      // M1: reject non-http(s) / SSRF-y / data: schemes so a hostile
      // URL cannot land in rollback_reason and later render as <a href>.
      const rollbackPrUrl =
        rawRollbackPrUrl && isSafeUrl(rawRollbackPrUrl) ? rawRollbackPrUrl : undefined;

      // H1: same binding as advance.
      const ownership = await assertRunBelongsToAlert(runId, alertId);
      if (ownership !== null) return ownership;

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
    if (!remediationId || !UUID_REGEX.test(remediationId)) {
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
    return NextResponse.json(serverError(err, "rollout-post"), { status: 500 });
  }
}

/**
 * Confirm the rollout run exists AND belongs to the authorized alert.
 * Returns null when the binding is valid; otherwise returns the
 * NextResponse the route should short-circuit with (404 / 400).
 *
 * This guard closes the cross-tenant IDOR where an authenticated user
 * with access to alert A could pass runId from alert B in the body
 * and mutate B's state machine — the authorize() helper only scopes
 * to alertId (URL param), not to arbitrary body fields.
 */
async function assertRunBelongsToAlert(
  runId: string,
  alertId: string,
): Promise<NextResponse | null> {
  const [runRow] = await db
    .select({ alertId: rolloutRuns.alertId })
    .from(rolloutRuns)
    .where(eq(rolloutRuns.id, runId))
    .limit(1);
  if (!runRow) {
    return NextResponse.json({ error: "Rollout run not found" }, { status: 404 });
  }
  if (runRow.alertId !== alertId) {
    return NextResponse.json(
      { error: "Rollout run does not belong to this alert" },
      { status: 400 },
    );
  }
  return null;
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
