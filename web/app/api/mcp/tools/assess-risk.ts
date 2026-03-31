import { db, projects, projectIntegrations, apiKeys } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { callAI } from "@/lib/ai/client";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

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

    // Get AI key
    const AI_SERVICES = ["claude", "openai", "grok", "deepseek", "gemini"];
    const keys = await db.select().from(apiKeys).where(eq(apiKeys.userId, user.userId));
    const aiKey = keys.find((k) => AI_SERVICES.includes(k.service));

    if (!aiKey) {
      return JSON.stringify(
        {
          project: project.name,
          pr_number: prNumber,
          diff_lines: diff.split("\n").length,
          note: "No AI key configured. Add one in Settings to enable risk assessment.",
        },
        null,
        2
      );
    }

    const decryptedKey = decrypt(aiKey.keyEncrypted);

    const systemPrompt = `You are a senior SRE reviewing a pull request for deployment risk. Analyze the diff and return:
1. Risk Level: Low / Medium / High
2. Key Findings (bullet points)
3. Risky Patterns (auth changes, DB migrations, env vars, etc.)
4. Recommendation

Be concise.`;

    const result = await callAI(decryptedKey, systemPrompt, [
      { role: "user", content: `PR #${prNumber} in ${repo}:\n\n${truncatedDiff}` },
    ]);

    return JSON.stringify(
      {
        project: project.name,
        pr_number: prNumber,
        repo,
        risk_assessment: result,
      },
      null,
      2
    );
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
