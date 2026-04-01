import { NextRequest, NextResponse } from "next/server";
import { db, alerts, projects, substrateRecordings, remediationSessions, apiKeys } from "@/lib/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { getUserProjectIds } from "@/lib/db";
import { getAlert } from "@/lib/services/alerts.service";
import { timingSafeEqual } from "crypto";

async function authenticateMobile(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();

  const keys = await db.select().from(apiKeys).where(eq(apiKeys.service, "mobile"));
  for (const key of keys) {
    const decrypted = decrypt(key.keyEncrypted);
    if (decrypted.length === token.length) {
      const a = Buffer.from(decrypted);
      const b = Buffer.from(token);
      if (timingSafeEqual(a, b)) return key.userId;
    }
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await authenticateMobile(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const alert = await getAlert(id);
  if (!alert) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Verify ownership
  const projectIds = await getUserProjectIds(userId);
  if (!projectIds.includes(alert.projectId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Get project name
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, alert.projectId)).limit(1);

  // Parallel enrichments
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
