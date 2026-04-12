/**
 * MCP tool: rollback_deploy
 *
 * Host-agnostic deployment rollback — dispatches to whichever hosting
 * provider the project has connected (Vercel, Netlify, Cloudflare Pages,
 * Render) via the shared `rollbackProjectDeploy` service.
 *
 * The legacy `rollback_vercel` tool is kept as an alias (same execute path)
 * for MCP clients still using the older name.
 */

import { db, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";
import { rollbackProjectDeploy } from "@/lib/services/alert-rollback";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser,
): Promise<string> {
  if (typeof args.project !== "string" || !args.project) {
    return "Error: project must be a non-empty string.";
  }
  const projectSlug = args.project;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, projectSlug))
    .limit(1);

  if (!project) return `Error: Project not found: ${projectSlug}`;

  const hasAccess = await userCanAccessProject(user.userId, project.id);
  if (!hasAccess) return `Error: Project not found: ${projectSlug}`;

  const result = await rollbackProjectDeploy({
    projectId: project.id,
    userId: user.userId,
    source: "mcp",
  });

  if (result.error) return `Error: ${result.error}`;

  return JSON.stringify(
    {
      status: "success",
      provider: result.provider,
      rolled_back_to: {
        deployment_id: result.deploymentId,
        url: result.url,
      },
    },
    null,
    2,
  );
}
