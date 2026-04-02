import type { McpUser } from "../auth";
import { getIndexStatus, triggerReindex } from "@/lib/services/code-intelligence.service";
import { db, projects, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const projectSlug = args.project as string;
  if (!projectSlug) return "Error: project is required.";

  // Resolve project
  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, projectSlug))
    .limit(1);
  if (!proj) return `Error: project "${projectSlug}" not found.`;

  const { getUserProjectIds } = await import("@/lib/db");
  const userProjects = await getUserProjectIds(user.userId);
  if (!userProjects.includes(proj.id)) return "Error: you don't have access to this project.";

  // Get GitHub integration
  const [integration] = await db
    .select()
    .from(projectIntegrations)
    .where(and(eq(projectIntegrations.projectId, proj.id), eq(projectIntegrations.service, "github")))
    .limit(1);

  if (!integration) return "Error: no GitHub integration found. Connect GitHub first.";

  const config = decryptConfig(integration.configEncrypted);
  const ghToken = config.token as string;
  const owner = config.owner as string;
  const repo = config.repo as string;

  if (!ghToken || !owner || !repo) return "Error: GitHub integration is missing token/owner/repo configuration.";

  // Get OpenAI key for AI enrichment
  let openaiKey: string | undefined;
  try {
    const { getProjectOwnerAIKey } = await import("@/lib/ai/get-key");
    const aiKey = await getProjectOwnerAIKey(proj.id);
    if (aiKey && aiKey.provider === "openai") openaiKey = aiKey.key;
  } catch { /* optional */ }

  // Trigger re-indexation
  try {
    const result = await triggerReindex({
      ghToken,
      owner,
      repo,
      projectId: proj.id,
      openaiKey,
    });

    return `Re-indexation completed for ${owner}/${repo}: ${result.chunksIndexed} chunks indexed.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return `Re-indexation failed: ${msg}`;
  }
}
