import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  alerts,
  remediationSessions,
  projects,
  projectIntegrations,
  organizations,
  organizationMembers,
} from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";
import {
  getFleetRunForAlert,
  startOrGetFleetRun,
} from "@/lib/services/what-if-fleet";
import { productMetrics, VAR_EVENTS } from "@/lib/telemetry/product-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Fleet Verification — VAR Gate 12.
 *
 * POST  /api/alerts/:alertId/fleet-verify — start/resume a run
 * GET   /api/alerts/:alertId/fleet-verify — poll status (returns null when
 *                                           no run has been kicked off yet)
 *
 * POST body: { remediationId }
 *   The alert's sessionId + fingerprint are read from the DB. The
 *   remediation's fixCommitSha is the cache key.
 *
 * Auth: NextAuth session + authz (project owner OR org member).
 * Idempotency: service-layer UNIQUE constraint on (alert, remediation, sha).
 */

export async function GET(
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

  const authed = await authorizeAlert(alertId, userId);
  if (!authed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const status = await getFleetRunForAlert(alertId);
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

  let body: { remediationId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const remediationId = typeof body.remediationId === "string" ? body.remediationId : null;
  if (!remediationId || !/^[0-9a-f-]{36}$/i.test(remediationId)) {
    return NextResponse.json({ error: "remediationId required (uuid)" }, { status: 400 });
  }

  const authed = await authorizeAlert(alertId, userId);
  if (!authed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Resolve the alert's fingerprint + the remediation's fix commit +
  // project id, all in one query.
  const [row] = await db
    .select({
      projectId: alerts.projectId,
      fingerprint: alerts.fingerprint,
      sessionId: alerts.sessionId,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      remediationAlertId: remediationSessions.alertId,
      branch: remediationSessions.branch,
    })
    .from(alerts)
    .innerJoin(remediationSessions, eq(remediationSessions.id, remediationId))
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Alert or remediation not found" }, { status: 404 });
  }
  if (row.remediationAlertId !== alertId) {
    return NextResponse.json({ error: "Remediation does not belong to this alert" }, { status: 400 });
  }
  if (!row.fingerprint) {
    return NextResponse.json(
      { error: "Alert has no fingerprint — cannot compute fleet" },
      { status: 422 },
    );
  }

  const fixCommitSha = row.mergedCommitSha ?? `branch:${row.branch ?? remediationId}`;

  const githubToken = await resolveGithubToken(row.projectId);

  try {
    const { runId, created, status } = await startOrGetFleetRun({
      alertId,
      remediationId,
      fixCommitSha,
      fingerprint: row.fingerprint,
      githubToken,
    });

    productMetrics.emit(VAR_EVENTS.FLEET_VERIFICATION_STARTED, {
      organizationId: null,
      valueText: alertId,
      metadata: { runId, remediationId, fixCommitSha, created },
    });

    return NextResponse.json({ runId, run: status }, { status: created ? 202 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function authorizeAlert(alertId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      projectId: alerts.projectId,
      alertFingerprint: alerts.fingerprint,
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

async function resolveGithubToken(projectId: string): Promise<string | undefined> {
  try {
    const rows = await db
      .select({ configEncrypted: projectIntegrations.configEncrypted })
      .from(projectIntegrations)
      .where(
        and(
          eq(projectIntegrations.projectId, projectId),
          eq(projectIntegrations.service, "github"),
        ),
      )
      .limit(1);
    if (!rows[0]?.configEncrypted) return undefined;
    const config = decryptConfig(rows[0].configEncrypted);
    const token = config.token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
