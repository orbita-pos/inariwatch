import { db, projects, projectIntegrations } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";

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

  // Get Vercel integration
  const [vercelIntegration] = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, target.id),
        eq(projectIntegrations.service, "vercel")
      )
    )
    .limit(1);

  if (!vercelIntegration)
    return `No Vercel integration configured for project "${target.name}".`;

  const config = vercelIntegration.configEncrypted as Record<string, string> | null;
  if (!config?.token || !config?.projectId)
    return "Vercel integration is incomplete (missing token or project ID).";

  const vercelToken = decrypt(config.token);
  const vercelProjectId = config.projectId;
  const teamId = config.teamId;

  try {
    // Fetch deployments
    const teamParam = teamId ? `&teamId=${teamId}` : "";
    const depsUrl = `https://api.vercel.com/v6/deployments?projectId=${vercelProjectId}&limit=5${teamParam}`;
    const depsResp = await fetch(depsUrl, {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });
    if (!depsResp.ok) return `Vercel API error: ${depsResp.status}`;

    const depsData = await depsResp.json();
    const deployments = depsData.deployments ?? [];

    const dep = deploymentId
      ? deployments.find((d: { uid: string }) => d.uid === deploymentId)
      : deployments.find((d: { state: string }) => d.state === "ERROR") ?? deployments[0];

    if (!dep) return "No deployments found.";

    // Fetch build logs
    const logsUrl = `https://api.vercel.com/v2/deployments/${dep.uid}/events${teamParam ? `?${teamParam.slice(1)}` : ""}`;
    const logsResp = await fetch(logsUrl, {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });
    if (!logsResp.ok) return `Could not fetch build logs: ${logsResp.status}`;

    const events = await logsResp.json();
    const logLines = Array.isArray(events)
      ? events
          .filter((e: { type: string }) => e.type === "stdout" || e.type === "stderr")
          .map((e: { payload?: { text?: string }; text?: string }) => e.payload?.text ?? e.text ?? "")
          .join("\n")
      : "No log output available.";

    return `Build logs for deployment ${dep.uid} (${dep.state}):\n\n${logLines.slice(0, 5000)}`;
  } catch (e) {
    return `Error fetching build logs: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
