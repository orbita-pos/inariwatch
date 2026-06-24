import { NextRequest, NextResponse } from "next/server";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";
import { getUserOrganizations, getWorkspaceProjectIds } from "@/lib/db";
import { getProjectHealth } from "@/lib/services/desktop-widgets.service";

/**
 * GET /api/desktop/projects/[id]/health
 *
 * Read-only per-project health snapshot consumed by the desktop chat
 * agent's `cloud.get_project_health` tool. Aggregates alerts (24h by
 * severity), uptime monitors, last deploy, and active integration
 * services so the LLM can answer "how is project X?" in one round-trip.
 *
 * Auth: desktop bearer token + visibility check — the path id MUST be
 * one of the projects the user can see across personal + every org
 * they belong to (same rule as `/api/desktop/projects`). Returns 404
 * for ids the user can't see so the endpoint doesn't leak workspace
 * boundaries by status code.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const { id } = await params;

  // Visibility check — mirror `/api/desktop/projects` resolver.
  const orgs = await getUserOrganizations(auth.userId);
  const idLists = await Promise.all([
    getWorkspaceProjectIds(auth.userId, null),
    ...orgs.map((o) => getWorkspaceProjectIds(auth.userId, o.id)),
  ]);
  const visibleIds = new Set(idLists.flat());
  if (!visibleIds.has(id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const health = await getProjectHealth(id);
  if (!health) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json(health);
}
