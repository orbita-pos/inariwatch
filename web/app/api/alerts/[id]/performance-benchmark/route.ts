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
  startOrGetBenchmark,
  getBenchmarkForAlert,
} from "@/lib/services/performance-benchmark.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * VAR Gate 17 — Performance Benchmark.
 *
 * GET  /api/alerts/:id/performance-benchmark — poll status
 * POST /api/alerts/:id/performance-benchmark — start/resume run
 *
 * POST body: { remediationId, thresholdPercent? }
 *
 * Auth: NextAuth + (project owner OR org member).
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

  const status = await getBenchmarkForAlert(alertId);
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

  let body: { remediationId?: unknown; thresholdPercent?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const remediationId = typeof body.remediationId === "string" ? body.remediationId : null;
  const threshold = typeof body.thresholdPercent === "number" ? body.thresholdPercent : undefined;
  if (!remediationId || !/^[0-9a-f-]{36}$/i.test(remediationId)) {
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
    return NextResponse.json({ error: "Remediation does not belong to this alert" }, { status: 400 });
  }

  const fixCommitSha = row.mergedCommitSha ?? `branch:${row.branch ?? remediationId}`;

  try {
    const { runId, created, status } = await startOrGetBenchmark({
      alertId,
      remediationId,
      fixCommitSha,
      thresholdPercent: threshold,
    });
    return NextResponse.json({ runId, run: status }, { status: created ? 202 : 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── Shared authz helper ───────────────────────────────────────────────────

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
