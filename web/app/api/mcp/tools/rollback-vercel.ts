import { db, projects, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

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

  const [vercelIntegration] = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, project.id),
        eq(projectIntegrations.service, "vercel")
      )
    )
    .limit(1);

  if (!vercelIntegration) return "No Vercel integration configured.";

  const config = vercelIntegration.configEncrypted as Record<string, string> | null;
  if (!config?.token || !config?.projectId) return "Vercel integration incomplete.";

  const vercelToken = decrypt(config.token);
  const vercelProjectId = config.projectId;
  const teamId = config.teamId;
  const teamParam = teamId ? `&teamId=${teamId}` : "";

  try {
    // Get recent READY deployments
    const url = `https://api.vercel.com/v6/deployments?projectId=${vercelProjectId}&state=READY&target=production&limit=5${teamParam}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });
    if (!resp.ok) return `Vercel API error: ${resp.status}`;

    const data = await resp.json();
    const deployments = data.deployments ?? [];

    const targetId = args.deployment_id as string | undefined;
    // Skip the current (first) deployment, roll back to the one before
    const target = targetId
      ? deployments.find((d: { uid: string }) => d.uid === targetId)
      : deployments[1]; // second most recent = last good

    if (!target) return "No previous production deployment found to roll back to.";

    // Promote that deployment
    const promoteUrl = `https://api.vercel.com/v13/deployments/${target.uid}/promote${teamId ? `?teamId=${teamId}` : ""}`;
    const promoteResp = await fetch(promoteUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${vercelToken}` },
    });

    if (!promoteResp.ok) {
      const err = await promoteResp.text();
      return `Rollback failed: ${promoteResp.status} ${err}`;
    }

    return JSON.stringify(
      {
        status: "success",
        rolled_back_to: {
          deployment_id: target.uid,
          url: target.url ? `https://${target.url}` : null,
          created_at: target.created ? new Date(target.created).toISOString() : null,
        },
      },
      null,
      2
    );
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
