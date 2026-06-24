"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projectIntegrations, getWorkspaceProjectIds } from "@/lib/db";
import { getActiveOrgId } from "@/lib/workspace";
import { inArray, max } from "drizzle-orm";

export async function getLatestPollingTime() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return null;

  const activeOrgId = await getActiveOrgId();
  const projectIds = await getWorkspaceProjectIds(userId, activeOrgId);
  if (projectIds.length === 0) return null;

  const [row] = await db
    .select({ last: max(projectIntegrations.lastCheckedAt) })
    .from(projectIntegrations)
    .where(inArray(projectIntegrations.projectId, projectIds));

  return row?.last?.toISOString() ?? null;
}
