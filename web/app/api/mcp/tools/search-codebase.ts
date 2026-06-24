import type { McpUser } from "../auth";
import { searchCode, getIndexStatus } from "@/lib/services/code-intelligence.service";
import { db, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const query = (args.query as string)?.slice(0, 500);
  if (!query) return "Error: query is required.";

  const limit = Math.min(Number(args.limit) || 5, 10);
  const projectSlug = args.project as string | undefined;

  // Resolve project ID(s)
  let projectIds: string[];
  if (projectSlug) {
    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, projectSlug))
      .limit(1);
    if (!proj) return `Error: project "${projectSlug}" not found.`;
    projectIds = [proj.id];
  } else {
    projectIds = await getUserProjectIds(user.userId);
  }

  if (projectIds.length === 0) return "No projects found.";

  // Check if any repos are indexed
  const allStatus = [];
  for (const pid of projectIds) {
    const status = await getIndexStatus(pid);
    allStatus.push(...status);
  }

  if (allStatus.length === 0) {
    return "No codebase indexed yet. Connect a GitHub integration to start indexing, or use the reindex_codebase tool.";
  }

  const readyRepos = allStatus.filter((s) => s.status === "ready");
  if (readyRepos.length === 0) {
    const indexing = allStatus.filter((s) => s.status === "indexing");
    if (indexing.length > 0) return "Codebase is currently being indexed. Try again in a few minutes.";
    return "Codebase indexing failed. Check the project settings.";
  }

  // Search across all ready projects
  const results = [];
  for (const pid of projectIds) {
    const found = await searchCode({ projectId: pid, query, limit });
    results.push(...found);
  }

  // Sort by score, deduplicate
  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, limit);

  if (topResults.length === 0) return `No code found matching: "${query}"`;

  let out = `Code search results for "${query}"\n${"=".repeat(50)}\n\n`;
  for (let i = 0; i < topResults.length; i++) {
    const r = topResults[i];
    out += `${i + 1}. ${r.language} ${r.chunkType} "${r.name}" — ${r.filePath}:${r.startLine}-${r.endLine}\n`;
    if (r.docstring) out += `   ${r.docstring.slice(0, 200)}\n`;
    out += `\`\`\`${r.language}\n${r.code.slice(0, 1000)}\n\`\`\`\n`;
    if (r.callers?.length) out += `   Called by: ${r.callers.map((c) => `${c.name} (${c.filePath})`).join(", ")}\n`;
    if (r.callees?.length) out += `   Calls: ${r.callees.map((c) => `${c.name} (${c.filePath})`).join(", ")}\n`;
    out += `   Score: ${r.score.toFixed(3)}\n\n`;
  }

  out += `\n${readyRepos.length} repo(s) indexed, ${readyRepos.reduce((sum, r) => sum + r.totalChunks, 0)} total chunks.`;
  return out;
}
