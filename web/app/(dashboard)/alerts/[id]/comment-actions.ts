"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alertComments, alerts, projects, getUserProjectIds } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addComment(
  alertId: string,
  body: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const trimmed = body.trim();
  if (!trimmed) return { error: "Comment cannot be empty." };
  if (trimmed.length > 2000) return { error: "Comment is too long (max 2000 characters)." };

  // Verify the user has access to the alert's project
  const [alert] = await db
    .select({ projectId: alerts.projectId })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return { error: "Alert not found." };

  const projectIds = await getUserProjectIds(userId);
  if (!projectIds.includes(alert.projectId)) {
    return { error: "You don't have access to this alert." };
  }

  await db.insert(alertComments).values({
    alertId,
    userId,
    body: trimmed,
  });

  revalidatePath(`/alerts/${alertId}`);
  return {};
}

export async function deleteComment(
  commentId: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  // Verify the comment belongs to the current user
  const [comment] = await db
    .select()
    .from(alertComments)
    .where(and(eq(alertComments.id, commentId), eq(alertComments.userId, userId)))
    .limit(1);

  if (!comment) return { error: "Comment not found or you don't own it." };

  await db.delete(alertComments).where(eq(alertComments.id, commentId));

  revalidatePath(`/alerts/${comment.alertId}`);
  return {};
}
