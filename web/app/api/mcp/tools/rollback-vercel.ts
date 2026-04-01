import { db, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";
import { rollbackToDeployment } from "@/lib/services/vercel.service";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const projectSlug = args.project as string;
  if (!projectSlug) return "Error: project is required.";

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, projectSlug))
    .limit(1);

  if (!project) return `Error: Project not found: ${projectSlug}`;

  const hasAccess = await userCanAccessProject(user.userId, project.id);
  if (!hasAccess) return `Error: Project not found: ${projectSlug}`;

  try {
    const result = await rollbackToDeployment(
      project.id,
      args.deployment_id as string | undefined
    );

    return JSON.stringify({
      status: "success",
      rolled_back_to: {
        deployment_id: result.uid,
        url: result.url,
        created_at: result.created,
      },
    }, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
