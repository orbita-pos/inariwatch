import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { runPrediction } from "@/lib/ai/prediction";
import { decryptConfig } from "@/lib/crypto";
import { rateLimit } from "@/lib/auth-rate-limit";

/**
 * POST /api/prediction
 * Run the prediction engine for a PR.
 * Body: { projectId, prNumber }
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: 10 predictions per minute
  const rl = await rateLimit("prediction", userId, { windowMs: 60_000, max: 10 });
  if (!rl.allowed) return NextResponse.json({ error: "Rate limited" }, { status: 429 });

  const body = await req.json();
  const { projectId, prNumber } = body;

  if (!projectId || !prNumber) {
    return NextResponse.json({ error: "Missing projectId or prNumber" }, { status: 400 });
  }

  // Verify project access
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // Get GitHub integration
  const [ghInteg] = await db
    .select()
    .from(projectIntegrations)
    .where(and(
      eq(projectIntegrations.projectId, projectId),
      eq(projectIntegrations.service, "github"),
      eq(projectIntegrations.isActive, true),
    ))
    .limit(1);

  if (!ghInteg) return NextResponse.json({ error: "No GitHub integration" }, { status: 400 });

  const config = decryptConfig(ghInteg.configEncrypted);
  const token = config.token as string;
  const owner = config.owner as string;
  const repo = config.repo as string;

  if (!token || !owner || !repo) {
    return NextResponse.json({ error: "GitHub integration misconfigured" }, { status: 400 });
  }

  const result = await runPrediction({ projectId, token, owner, repo, prNumber });

  if (!result) return NextResponse.json({ error: "Prediction failed" }, { status: 500 });

  return NextResponse.json(result);
}
