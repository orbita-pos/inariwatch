/**
 * POST /api/code-intelligence/index
 *
 * Triggers codebase indexation for a project.
 * Called by: GitHub integration connect, push webhooks, manual re-index.
 * Runs in background — returns immediately.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projectIntegrations, codeRepositories, getUserProjectIds } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";
import { indexRepository } from "@/lib/code-intelligence/indexer";

// Rate limit: 1 indexation per repo per 5 minutes
const lastIndexTime = new Map<string, number>();
const INDEX_COOLDOWN_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { projectId, owner, repo } = body as { projectId?: string; owner?: string; repo?: string };

  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  // Authorization: verify user has access to this project
  const userProjects = await getUserProjectIds(userId);
  if (!userProjects.includes(projectId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Rate limiting
  const rateKey = `${projectId}:${owner ?? ""}:${repo ?? ""}`;
  const lastTime = lastIndexTime.get(rateKey);
  if (lastTime && Date.now() - lastTime < INDEX_COOLDOWN_MS) {
    return NextResponse.json({ status: "throttled", message: "Re-indexing cooldown (5 min)" });
  }

  // Get GitHub integration for this project
  const [integration] = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "github")
      )
    )
    .limit(1);

  if (!integration) {
    return NextResponse.json({ error: "No GitHub integration found" }, { status: 404 });
  }

  const config = decryptConfig(integration.configEncrypted);
  const ghToken = config.token as string;
  const ghOwner = (owner ?? config.owner) as string;
  const ghRepo = (repo ?? config.repo) as string;

  if (!ghToken || !ghOwner || !ghRepo) {
    return NextResponse.json({ error: "GitHub token/owner/repo not configured" }, { status: 400 });
  }

  // Get OpenAI key for docstrings + embeddings (optional)
  let openaiKey: string | undefined;
  try {
    const { getProjectOwnerAIKey } = await import("@/lib/ai/get-key");
    const aiKey = await getProjectOwnerAIKey(projectId);
    if (aiKey && aiKey.provider === "openai") {
      openaiKey = aiKey.key;
    }
  } catch {
    // No AI key — indexing will still work, just without docstrings/embeddings
  }

  // Mark rate limit
  lastIndexTime.set(rateKey, Date.now());

  // Start indexation in background (fire-and-forget)
  indexRepository({
    ghToken,
    owner: ghOwner,
    repo: ghRepo,
    projectId,
    openaiKey,
  }).catch((err) => {
    console.error(`[code-intelligence] Indexation failed for ${ghOwner}/${ghRepo}:`, err);
  });

  return NextResponse.json({ status: "indexing", message: `Started indexing ${ghOwner}/${ghRepo}` });
}
