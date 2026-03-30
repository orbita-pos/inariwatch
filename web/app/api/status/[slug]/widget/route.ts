import { NextRequest, NextResponse } from "next/server";
import {
  db, statusPages, projects, alerts, uptimeMonitors, uptimeChecks,
  statusPageIncidents,
} from "@/lib/db";
import { eq, and, gte, inArray, ne, desc } from "drizzle-orm";

/**
 * GET /api/status/:slug/widget
 *
 * Lightweight status data for the embeddable widget.
 * Public, no auth, CORS open.
 *
 * Returns:
 *   status       — "operational" | "degraded" | "major_outage"
 *   label        — human-readable label
 *   uptimePct    — 90-day uptime % (null if no monitors configured)
 *   activeIncidents — count of active incidents
 *   slug         — echo of the slug
 *   pageUrl      — full URL to the public status page
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // Cache for 60 seconds at the CDN layer
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const [page] = await db
    .select()
    .from(statusPages)
    .where(and(eq(statusPages.slug, slug), eq(statusPages.isPublic, true)))
    .limit(1);

  if (!page) {
    return NextResponse.json({ error: "Status page not found" }, { status: 404, headers: CORS });
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, page.projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Status page not found" }, { status: 404, headers: CORS });
  }

  const sevenDaysAgo  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [recentAlerts, activeIncidents, monitors] = await Promise.all([
    db.select({ severity: alerts.severity, isResolved: alerts.isResolved })
      .from(alerts)
      .where(and(eq(alerts.projectId, project.id), gte(alerts.createdAt, sevenDaysAgo)))
      .limit(50),

    db.select({ id: statusPageIncidents.id })
      .from(statusPageIncidents)
      .where(and(
        eq(statusPageIncidents.statusPageId, page.id),
        ne(statusPageIncidents.status, "resolved"),
      ))
      .limit(10),

    db.select({ id: uptimeMonitors.id })
      .from(uptimeMonitors)
      .where(and(eq(uptimeMonitors.projectId, project.id), eq(uptimeMonitors.isActive, true))),
  ]);

  // Uptime % — average across all monitors over last 90 days
  let uptimePct: number | null = null;
  if (monitors.length > 0) {
    const checks = await db
      .select({ isUp: uptimeChecks.isUp })
      .from(uptimeChecks)
      .where(and(
        inArray(uptimeChecks.monitorId, monitors.map((m) => m.id)),
        gte(uptimeChecks.checkedAt, ninetyDaysAgo),
      ));

    if (checks.length > 0) {
      const upCount = checks.filter((c) => c.isUp).length;
      uptimePct = Math.round((upCount / checks.length) * 1000) / 10; // one decimal
    }
  }

  // Overall status
  const hasCriticalIncident = activeIncidents.length > 0 &&
    recentAlerts.some((a) => a.severity === "critical" && !a.isResolved);
  const openCritical = recentAlerts.filter((a) => a.severity === "critical" && !a.isResolved);
  const openWarning  = recentAlerts.filter((a) => a.severity === "warning"  && !a.isResolved);

  const overallStatus =
    hasCriticalIncident || openCritical.length > 0 ? "major_outage" :
    activeIncidents.length > 0 || openWarning.length > 0 ? "degraded" :
    "operational";

  const LABELS: Record<string, string> = {
    operational:  "All Systems Operational",
    degraded:     "Degraded Performance",
    major_outage: "Major Outage",
  };

  const appUrl = process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? "https://app.inariwatch.com";

  return NextResponse.json({
    status:          overallStatus,
    label:           LABELS[overallStatus],
    uptimePct,
    activeIncidents: activeIncidents.length,
    slug,
    pageUrl:         `${appUrl}/status/${slug}`,
  }, { headers: CORS });
}
