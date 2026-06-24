/**
 * GET /api/test-generation/list?projectId=<uuid>&limit=20&offset=0
 *
 * Returns a paginated list of test_generation_sessions for the active
 * project, scoped to the authenticated user. Used by the /tests page
 * (web dashboard) to show all test generations.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db, projects, testGenerationSessions } from "@/lib/db";
import { and, desc, eq } from "drizzle-orm";
import { authenticateExtensionToken } from "@/lib/auth-extension";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

const QuerySchema = z.object({
  projectId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const bearer = await authenticateExtensionToken(req);
  if (bearer) return bearer.userId;
  const session = await getServerSession(authOptions);
  return (session?.user as { id?: string } | undefined)?.id ?? null;
}

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let q: z.infer<typeof QuerySchema>;
  try {
    const url = new URL(req.url);
    q = QuerySchema.parse({
      projectId: url.searchParams.get("projectId") ?? "",
      limit:     url.searchParams.get("limit")     ?? undefined,
      offset:    url.searchParams.get("offset")    ?? undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid query", detail: err instanceof z.ZodError ? err.flatten() : String(err) },
      { status: 400 },
    );
  }

  // Authorize project access — only return rows for projects the user owns
  const [project] = await db
    .select({ id: projects.id, userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, q.projectId))
    .limit(1);
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: testGenerationSessions.id,
      sourceKind: testGenerationSessions.sourceKind,
      sourceTarget: testGenerationSessions.sourceTarget,
      status: testGenerationSessions.status,
      frameworkDetected: testGenerationSessions.frameworkDetected,
      costCents: testGenerationSessions.costCents,
      durationMs: testGenerationSessions.durationMs,
      error: testGenerationSessions.error,
      alertId: testGenerationSessions.alertId,
      createdAt: testGenerationSessions.createdAt,
      updatedAt: testGenerationSessions.updatedAt,
    })
    .from(testGenerationSessions)
    .where(
      and(
        eq(testGenerationSessions.projectId, q.projectId),
        eq(testGenerationSessions.userId, userId),
      ),
    )
    .orderBy(desc(testGenerationSessions.createdAt))
    .limit(q.limit)
    .offset(q.offset);

  return NextResponse.json({
    sessions: rows,
    page: { limit: q.limit, offset: q.offset, count: rows.length },
  });
}
