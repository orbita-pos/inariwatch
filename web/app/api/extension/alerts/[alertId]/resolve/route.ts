/**
 * POST /api/extension/alerts/{alertId}/resolve — Resolve an alert
 */

import { NextRequest, NextResponse } from "next/server";
import { db, alerts } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";
import { requireExtensionAuth } from "@/lib/auth/extension";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ alertId: string }> }
) {
  const auth = await requireExtensionAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const { alertId } = await params;

  // Verify ownership
  const projectIds = await getUserProjectIds(userId);
  const [alert] = await db
    .select({ id: alerts.id, projectId: alerts.projectId })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert || !projectIds.includes(alert.projectId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db
    .update(alerts)
    .set({ isRead: true, isResolved: true, resolvedAt: new Date() })
    .where(eq(alerts.id, alertId));

  return NextResponse.json({ ok: true });
}
