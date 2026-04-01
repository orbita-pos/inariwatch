import { NextRequest, NextResponse } from "next/server";
import { db, remediationSessions, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";
import { requireMobileAuth } from "@/lib/auth/mobile";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMobileAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const { id } = await params;

  const [session] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.id, id))
    .limit(1);

  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const projectIds = await getUserProjectIds(userId);
  if (!projectIds.includes(session.projectId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
