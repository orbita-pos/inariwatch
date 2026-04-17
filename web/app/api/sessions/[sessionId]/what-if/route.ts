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
import { getOrComputeWhatIf, readCache } from "@/lib/services/what-if";
import { getProjectOwnerAIKey, PLATFORM_MODEL } from "@/lib/ai/get-key";
import { decryptConfig } from "@/lib/crypto";
import { productMetrics, VAR_EVENTS } from "@/lib/telemetry/product-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sessions/[sessionId]/what-if
 *
 * Body: { remediationId: string, computeIfMissing?: boolean }
 *
 * - GET-style use: pass `computeIfMissing: false` to ONLY return cached
 *   results (cheap, never spends AI tokens). Returns 404 on cache miss.
 * - POST-style use: pass `computeIfMissing: true` (or omit) to compute
 *   fresh on cache miss. May incur an AI call.
 *
 * Auth: NextAuth session + viewer must be a member of the alert's org.
 *
 * Returns: WhatIfResult with `fromCache` flag, or 404/403/etc.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;
  if (!sessionId || sessionId.length > 128 || !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  let body: { remediationId?: unknown; computeIfMissing?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const remediationId = typeof body.remediationId === "string" ? body.remediationId : null;
  const computeIfMissing = body.computeIfMissing !== false;

  if (!remediationId || !/^[0-9a-f-]{36}$/i.test(remediationId)) {
    return NextResponse.json({ error: "remediationId required (uuid)" }, { status: 400 });
  }

  // Resolve the remediation row + its alert + its project. We do every
  // join in one round-trip to keep the auth check tight (one window for
  // a TOCTOU race between resolve and access check).
  const [row] = await db
    .select({
      remediationId: remediationSessions.id,
      alertId: remediationSessions.alertId,
      projectId: remediationSessions.projectId,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      branch: remediationSessions.branch,
      fileChanges: remediationSessions.fileChanges,
      alertSessionId: alerts.sessionId,
      alertTitle: alerts.title,
      alertReasoning: alerts.aiReasoning,
    })
    .from(remediationSessions)
    .innerJoin(alerts, eq(alerts.id, remediationSessions.alertId))
    .where(eq(remediationSessions.id, remediationId))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Remediation not found" }, { status: 404 });
  }

  // The session id in the URL must match the alert's session id — prevents
  // a viewer of session A from running What-If for fix B on session C.
  if (row.alertSessionId !== sessionId) {
    return NextResponse.json({ error: "Remediation does not belong to this session" }, { status: 400 });
  }

  // Authz: viewer must be the project owner OR a member of the project's org.
  const [access] = await db
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(organizations, eq(organizations.id, projects.organizationId))
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, projects.organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(projects.id, row.projectId),
        or(
          eq(projects.userId, userId),
          eq(organizations.ownerId, userId),
          eq(organizationMembers.userId, userId),
        ),
      ),
    )
    .limit(1);

  if (!access) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fix commit sha is the cache key. mergedCommitSha is the canonical
  // value once a fix is auto-merged; for unmerged remediations we derive
  // a stable proxy from the branch name (still per-remediation unique).
  const fixCommitSha = row.mergedCommitSha ?? `branch:${row.branch ?? row.remediationId}`;

  // Fast path: cache only.
  if (!computeIfMissing) {
    const cached = await readCache(sessionId, fixCommitSha);
    if (!cached) {
      return NextResponse.json({ error: "Not computed yet" }, { status: 404 });
    }
    productMetrics.emit(VAR_EVENTS.WHATIF_REPLAY_CACHE_HIT, {
      organizationId: null,
      valueText: sessionId,
      metadata: { remediationId, fixCommitSha },
    });
    return NextResponse.json(cached);
  }

  // Compute path: resolve API key, run analyzeReplay-backed compute.
  const aiKey = await getProjectOwnerAIKey(row.projectId);
  if (!aiKey) {
    return NextResponse.json({ error: "No AI key available for project" }, { status: 503 });
  }

  // Resolve GitHub token so the worker can clone the repo at fix SHA.
  // Missing token is not fatal — the What-If service will fall back to
  // local substrate (dev) or AI prediction if the worker path can't run.
  const githubToken = await resolveGithubToken(row.projectId);

  productMetrics.emit(VAR_EVENTS.WHATIF_REPLAY_REQUESTED, {
    organizationId: null,
    valueText: sessionId,
    metadata: { remediationId, fixCommitSha },
  });

  const fileChanges = Array.isArray(row.fileChanges)
    ? (row.fileChanges as Array<{ path: string; content: string }>)
    : [];

  const result = await getOrComputeWhatIf({
    sessionId,
    fixCommitSha,
    remediationId,
    alertId: row.alertId,
    projectId: row.projectId,
    diagnosis: row.alertReasoning ?? `Alert: ${row.alertTitle}`,
    fixFiles: fileChanges,
    apiKey: aiKey.key,
    provider: aiKey.provider,
    model: aiKey.modelPrefs?.remediation ?? PLATFORM_MODEL,
    userId,
    isPlatformKey: aiKey.isPlatformKey,
    githubToken,
  });

  if (!result) {
    productMetrics.emit(VAR_EVENTS.WHATIF_REPLAY_FAILED, {
      organizationId: null,
      valueText: sessionId,
      metadata: { remediationId, reason: "compute_returned_null" },
    });
    return NextResponse.json({ error: "What-If computation failed (no recording or AI error)" }, { status: 422 });
  }

  productMetrics.emit(VAR_EVENTS.WHATIF_REPLAY_COMPUTED, {
    organizationId: null,
    valueText: sessionId,
    valueNumeric: result.confidence,
    metadata: {
      remediationId,
      outcome: result.outcome,
      riskScore: result.riskScore,
      fromCache: result.fromCache,
      mode: result.mode,
    },
  });

  return NextResponse.json(result);
}

/**
 * Look up the GitHub integration token for a project. Returns undefined
 * when the project hasn't connected GitHub or the stored blob fails to
 * decrypt — the What-If service treats missing token as "worker path
 * unavailable" and falls back to local substrate or AI. We don't surface
 * errors from here because What-If has a graceful degradation path; the
 * worker path is an optimization, not a requirement.
 */
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
