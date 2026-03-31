import { db, remediationSessions } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const sessionId = args.session_id as string;
  if (!sessionId) return "Error: session_id is required.";
  if (typeof args.worked !== "boolean") return "Error: worked (boolean) is required.";

  const [session] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.id, sessionId))
    .limit(1);

  if (!session) return `Error: Remediation session not found: ${sessionId}`;

  // Verify ownership
  const hasAccess = await userCanAccessProject(user.userId, session.projectId);
  if (!hasAccess) return "Error: Session does not belong to your projects.";

  const newStatus = args.worked ? "completed" : "failed";
  await db
    .update(remediationSessions)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(remediationSessions.id, sessionId));

  return args.worked
    ? `Feedback recorded: fix worked. Session ${sessionId} marked completed.`
    : `Feedback recorded: fix failed. Session ${sessionId} marked failed.`;
}
