/**
 * GET /api/test-generation/[id]
 *
 * Returns full detail of a single test generation session — the test
 * file content, the plan, the reviewer verdict, the static gates, the
 * model breakdown, the cost. Used by the /tests/[id] detail page.
 */

import { NextRequest, NextResponse } from "next/server";

import { db, projects, testGenerationSessions } from "@/lib/db";
import { eq } from "drizzle-orm";
import { authenticateExtensionToken } from "@/lib/auth-extension";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const bearer = await authenticateExtensionToken(req);
  if (bearer) return bearer.userId;
  const session = await getServerSession(authOptions);
  return (session?.user as { id?: string } | undefined)?.id ?? null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(testGenerationSessions)
    .where(eq(testGenerationSessions.id, id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Authorize — user can only see their own sessions
  if (row.userId !== userId) {
    // Confirm via project ownership too in case userId was migrated
    const [project] = await db
      .select({ userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .limit(1);
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  return NextResponse.json({ session: row });
}
