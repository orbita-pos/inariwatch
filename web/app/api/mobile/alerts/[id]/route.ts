import { NextRequest, NextResponse } from "next/server";
import { db, projects, substrateRecordings, remediationSessions } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";
import { getAlert } from "@/lib/services/alerts.service";
import { requireMobileAuth } from "@/lib/auth/mobile";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMobileAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const { id } = await params;
  const alert = await getAlert(id);
  if (!alert) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const projectIds = await getUserProjectIds(userId);
  if (!projectIds.includes(alert.projectId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, alert.projectId)).limit(1);

  const [substrate, remediations] = await Promise.all([
    db.select().from(substrateRecordings).where(eq(substrateRecordings.alertId, id)).limit(1),
    db.select().from(remediationSessions).where(eq(remediationSessions.alertId, id)).orderBy(desc(remediationSessions.createdAt)).limit(5),
  ]);

  return NextResponse.json({
    ...alert,
    projectName: project?.name ?? "?",
    substrate: substrate[0] ?? null,
    remediations,
  });
}
