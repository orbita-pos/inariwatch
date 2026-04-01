import { db, projects, uptimeMonitors } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

/** Block SSRF: reject private/internal IPs and non-HTTP schemes */
function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    if (host.startsWith("10.")) return false;
    if (host.startsWith("172.") && parseInt(host.split(".")[1]) >= 16 && parseInt(host.split(".")[1]) <= 31) return false;
    if (host.startsWith("192.168.")) return false;
    if (host.startsWith("169.254.")) return false;
    if (host.endsWith(".internal") || host.endsWith(".local")) return false;
    return true;
  } catch {
    return false;
  }
}

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
