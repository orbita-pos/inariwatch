import { db, projects } from "@/lib/db";
import { inArray } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";
import { getBuildLogs } from "@/lib/services/vercel.service";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const projectSlug = args.project as string | undefined;
  const deploymentId = args.deployment_id as string | undefined;

  const projectIds = await getUserProjectIds(user.userId);
  const userProjects = projectIds.length > 0
    ? await db.select().from(projects).where(inArray(projects.id, projectIds))
    : [];

  const target = projectSlug
    ? userProjects.find((p) => p.slug === projectSlug)
    : userProjects[0];

  if (!target) return "Error: Project not found.";

  try {
    const result = await getBuildLogs(target.id, deploymentId);
    return `Build logs for deployment ${result.deploymentUid} (${result.state}):\n\n${result.logs}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
