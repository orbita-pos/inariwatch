import { NextRequest, NextResponse } from "next/server";
import { db, remediationSessions, projects, apiKeys } from "@/lib/db";
import { eq } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { getUserProjectIds } from "@/lib/db";
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

  const [session] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.id, id))
    .limit(1);

  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Verify ownership
  const projectIds = await getUserProjectIds(userId);
  if (!projectIds.includes(session.projectId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Get project name
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, session.projectId))
    .limit(1);

  return NextResponse.json({
    id: session.id,
    alertId: session.alertId,
    projectName: project?.name ?? "?",
    status: session.status,
    attempt: session.attempt,
    maxAttempts: session.maxAttempts,
    steps: session.steps ?? [],
    repo: session.repo,
    branch: session.branch,
    prUrl: session.prUrl,
    prNumber: session.prNumber,
    fileChanges: session.fileChanges,
    confidenceScore: session.confidenceScore,
    selfReviewResult: session.selfReviewResult,
    mergeStrategy: session.mergeStrategy,
    error: session.error,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  });
}
