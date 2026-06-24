/**
 * GET /api/desktop/alert/[id]
 *
 * Single-alert detail for the Inari Live desktop's `Cmd+\`
 * AlertDetailPanel header + live banner. Returns enough to render:
 *   - severity badge, title, source integration, project name
 *   - "Still firing" vs "Resolved Xm ago" status
 *   - last event timestamp (proxy: alerts.updatedAt for firing,
 *     alerts.resolvedAt when present)
 *
 * Distinct from `/api/desktop/alerts` (the list endpoint) — that one
 * returns unread critical/warning rows; this one returns ANY alert
 * the bearer can access, including resolved or low severity.
 *
 * Auth: same as `/api/desktop/alerts` — extension Bearer token.
 *
 * 404 when the alert doesn't exist OR isn't in the bearer's project
 * scope. We don't distinguish (both are "not found" from the
 * client's POV) to avoid leaking workspace membership.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, alerts, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";

export interface AlertDetailResponse {
  id: string;
  title: string;
  body: string | null;
  severity: string;            // 'critical' | 'warning' | 'info' | 'low'
  sourceIntegrations: string[];
  fingerprint: string | null;
  /** True once the alert was resolved/silenced (silence is alias for resolve in this codebase). */
  isResolved: boolean;
  resolvedAt: string | null;
  isRead: boolean;
  projectId: string;
  projectName: string;
  projectSlug: string | null;
  createdAt: string;
  /** Best-effort "last activity" — sentAt when set, otherwise createdAt. */
  lastEventAt: string;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const { id } = await ctx.params;

  const [row] = await db
    .select({
      a: alerts,
      pName: projects.name,
      pSlug: projects.slug,
    })
    .from(alerts)
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .where(eq(alerts.id, id))
    .limit(1);

  if (!row || !auth.projectIds.includes(row.a.projectId)) {
    return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  }

  const a = row.a;
  const payload: AlertDetailResponse = {
    id:                 a.id,
    title:              a.title,
    body:               a.body,
    severity:           a.severity,
    sourceIntegrations: a.sourceIntegrations,
    fingerprint:        a.fingerprint ?? null,
    isResolved:         a.isResolved,
    resolvedAt:         a.resolvedAt ? a.resolvedAt.toISOString() : null,
    isRead:             a.isRead,
    projectId:          a.projectId,
    projectName:        row.pName,
    projectSlug:        row.pSlug ?? null,
    createdAt:          a.createdAt.toISOString(),
    lastEventAt:        (a.sentAt ?? a.createdAt).toISOString(),
  };
  return NextResponse.json(payload);
}
