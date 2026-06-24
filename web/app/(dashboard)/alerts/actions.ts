"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, getWorkspaceProjectIds } from "@/lib/db";
import { getActiveOrgId } from "@/lib/workspace";
import { eq, and, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function markAllAlertsRead() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) throw new Error("Unauthorized");

  const projectIds = await getWorkspaceProjectIds(userId, await getActiveOrgId());
  if (projectIds.length === 0) return;

  await db
    .update(alerts)
    .set({ isRead: true })
    .where(and(
      inArray(alerts.projectId, projectIds),
      eq(alerts.isRead, false),
    ));

  revalidatePath("/alerts");
  revalidatePath("/dashboard");
}
