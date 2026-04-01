import { NextRequest, NextResponse } from "next/server";
import { db, apiKeys, projects } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { getUserProjectIds } from "@/lib/db";
import { queryAlerts } from "@/lib/services/alerts.service";
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

export async function GET(req: NextRequest) {
  const userId = await authenticateMobile(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const severity = url.searchParams.get("severity") as "critical" | "warning" | "info" | undefined;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);
  const offset = Number(url.searchParams.get("offset")) || 0;

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) return NextResponse.json({ alerts: [], unreadCount: 0 });

  const userProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  const alerts = await queryAlerts({
    projectIds,
    severity: severity || undefined,
    isResolved: false,
    limit,
  });

  const unreadCount = alerts.filter((a) => !a.isRead).length;

  return NextResponse.json({
    alerts: alerts.map((a) => ({ ...a, projectName: projectMap[a.projectId] ?? "?" })),
    unreadCount,
  });
}
