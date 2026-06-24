import { NextRequest, NextResponse } from "next/server";
import { db, alerts, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import { parseInariHash } from "@/lib/inari-hash";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  const { hash } = await params;

  const parsed = parseInariHash(decodeURIComponent(hash));
  if (!parsed) {
    return NextResponse.json({ error: "invalid_hash" }, { status: 400 });
  }

  // Reconstruct the full inari hash from the bare hex if needed
  const fullHash = hash.startsWith("inari:") ? hash : `inari:${parsed.type}:${parsed.hex}`;

  if (parsed.type === "alert") {
    const [row] = await db
      .select({
        id: alerts.id,
        title: alerts.title,
        severity: alerts.severity,
        alertType: alerts.alertType,
        isResolved: alerts.isResolved,
        createdAt: alerts.createdAt,
        projectId: alerts.projectId,
        inariHash: alerts.inariHash,
        projectName: projects.name,
      })
      .from(alerts)
      .innerJoin(projects, eq(alerts.projectId, projects.id))
      .where(eq(alerts.inariHash, fullHash))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? "https://app.inariwatch.com";

    return NextResponse.json({
      type: "alert",
      id: row.id,
      inariHash: row.inariHash,
      title: row.title,
      severity: row.severity,
      alertType: row.alertType,
      isResolved: row.isResolved,
      createdAt: row.createdAt,
      project: { id: row.projectId, name: row.projectName },
      url: `${appUrl}/alerts/${row.id}`,
    });
  }

  return NextResponse.json({ error: "unsupported_type" }, { status: 400 });
}
