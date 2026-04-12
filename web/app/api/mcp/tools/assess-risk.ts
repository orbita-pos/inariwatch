import { db, projects, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

const RISK_ASSESSMENT_PROMPT = `You are a senior SRE reviewing a pull request for deployment risk. Analyze the diff and return:
1. Risk Level: Low / Medium / High
2. Key Findings (bullet points)
3. Risky Patterns (auth changes, DB migrations, env vars, etc.)
4. Recommendation

Be concise.`;

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const projectSlug = args.project as string;
  const prNumber = Number(args.pr_number);
  if (!projectSlug) return "Error: project is required.";
  if (!prNumber) return "Error: pr_number is required.";

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, projectSlug))
    .limit(1);

  if (!project) return `Error: Project not found: ${projectSlug}`;

  const hasAccess = await userCanAccessProject(user.userId, project.id);
  if (!hasAccess) return `Error: Project not found: ${projectSlug}`;

  // Get GitHub integration
  const [ghIntegration] = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, project.id),
        eq(projectIntegrations.service, "github")
      )
    )
    .limit(1);

  if (!ghIntegration) return "No GitHub integration configured.";

  const ghConfig = ghIntegration.configEncrypted as Record<string, string> | null;
  if (!ghConfig?.token || !ghConfig?.repo) return "GitHub integration incomplete.";

  const ghToken = decrypt(ghConfig.token);
  const repo = ghConfig.repo;

  // Fetch PR diff
  try {
    const prResp = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github.v3.diff",
      },
    });
    if (!prResp.ok) return `GitHub API error: ${prResp.status}`;

    const diff = await prResp.text();
    const truncatedDiff = diff.slice(0, 8000);

    // Sampling-first: let the client LLM assess the risk
    return JSON.stringify({
      project: project.name,
      pr_number: prNumber,
      repo,
      diff_lines: diff.split("\n").length,
      _sampling_request: {
        description: "Assess the deployment risk of this PR using the diff below.",
        systemPrompt: RISK_ASSESSMENT_PROMPT,
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `PR #${prNumber} in ${repo}:\n\n${truncatedDiff}`,
          },
        }],
        context: { project: projectSlug, pr_number: prNumber, tool: "assess_risk" },
        maxTokens: 2000,
      },
    }, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
