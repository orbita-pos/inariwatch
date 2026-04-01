import { db, projects, uptimeMonitors } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";
import { isSafeUrl } from "@/lib/services/url-validation";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const url = args.url as string;
  const projectSlug = args.project as string;
  const name = (args.name as string) || undefined;
  const intervalSec = Math.max(30, Math.min(Number(args.interval_sec) || 60, 3600));
  const expectedStatus = Number(args.expected_status) || 200;

  if (!url) return "Error: url is required.";
  if (!projectSlug) return "Error: project is required.";

  if (!isSafeUrl(url)) {
    return "Error: URL must be a public HTTP(S) endpoint. Private/internal IPs are not allowed.";
  }

  // Find project
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, projectSlug))
    .limit(1);

  if (!project) return `Error: Project not found: ${projectSlug}`;
  if (!(await userCanAccessProject(user.userId, project.id)))
    return `Error: Project not found: ${projectSlug}`;

  // Create monitor
  const [monitor] = await db
    .insert(uptimeMonitors)
    .values({
      projectId: project.id,
      url,
      name: name || url,
      intervalSec,
      expectedStatus,
      isActive: true,
    })
    .returning();

  return JSON.stringify(
    {
      status: "created",
      monitor: {
        id: monitor.id,
        url: monitor.url,
        name: monitor.name,
        interval_sec: monitor.intervalSec,
        expected_status: monitor.expectedStatus,
        project: project.name,
      },
    },
    null,
    2
  );
}
