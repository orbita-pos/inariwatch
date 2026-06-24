import { NextRequest, NextResponse } from "next/server";
import {
  db,
  projects,
  alerts,
  projectIntegrations,
  getUserOrganizations,
  getWorkspaceProjectIds,
} from "@/lib/db";
import { and, eq, inArray, max } from "drizzle-orm";
import { authenticateExtensionToken } from "@/lib/auth-extension";

/**
 * GET /api/desktop/projects
 *
 * Bearer-authed list of projects visible to the calling user across
 * ALL their workspaces (personal + every org they own or are a
 * member of). Used by Inari Live's Settings → Projects panel.
 *
 * The bearer's `auth.projectIds` is filtered by `userId` only, so it
 * misses workspace projects this user has access to. We re-resolve
 * here via `getWorkspaceProjectIds` per-org, applying the same
 * restricted-visibility rules the dashboard uses.
 *
 * Each row carries `workspaceName` ("Personal" when `organizationId`
 * is null, or the org's name) so the panel can render the workspace
 * inline without a second round-trip.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Optional `?integration=<service>` filter — when set, return ONLY
  // projects where that integration is active. Used by the desktop
  // chat agent's `cloud.list_projects` tool when the user asks about
  // one specific integration ("which have capture?"). Validated as
  // `[a-z_]+` because the column stores a closed set of service
  // names; reject anything else as a typo / probe before it touches
  // the SQL.
  const integrationFilter = req.nextUrl.searchParams.get("integration");
  if (integrationFilter !== null && !/^[a-z_]+$/.test(integrationFilter)) {
    return NextResponse.json(
      { error: "Invalid integration filter: must match [a-z_]+" },
      { status: 400 },
    );
  }

  // Resolve every workspace this user can see — personal (orgId null)
  // plus each org they own or are a member of. Each call applies the
  // restricted-visibility logic from `getWorkspaceProjectIds`.
  const orgs = await getUserOrganizations(auth.userId);
  const orgNameById = new Map<string, string>();
  for (const o of orgs) orgNameById.set(o.id, o.name);

  const idLists = await Promise.all([
    getWorkspaceProjectIds(auth.userId, null),
    ...orgs.map((o) => getWorkspaceProjectIds(auth.userId, o.id)),
  ]);
  const visibleIds = Array.from(new Set(idLists.flat()));

  if (visibleIds.length === 0) {
    return NextResponse.json({ projects: [] });
  }

  const rows = await db
    .select({
      id:             projects.id,
      name:           projects.name,
      slug:           projects.slug,
      state:          projects.state,
      framework:      projects.framework,
      host:           projects.host,
      organizationId: projects.organizationId,
      createdAt:      projects.createdAt,
      lastActivityAt: max(alerts.createdAt),
    })
    .from(projects)
    .leftJoin(alerts, eq(alerts.projectId, projects.id))
    .where(inArray(projects.id, visibleIds))
    .groupBy(projects.id);

  // Pull every active integration row for the visible projects in one
  // batch — desktop's `cloud.list_projects` agent tool needs the
  // service list inline so the LLM can answer "which projects have
  // capture?" without N+1 follow-up calls.
  const integrationRows = await db
    .select({
      projectId: projectIntegrations.projectId,
      service: projectIntegrations.service,
    })
    .from(projectIntegrations)
    .where(
      and(
        inArray(projectIntegrations.projectId, visibleIds),
        eq(projectIntegrations.isActive, true),
      ),
    );
  const integrationsByProject = new Map<string, Set<string>>();
  for (const r of integrationRows) {
    let set = integrationsByProject.get(r.projectId);
    if (!set) {
      set = new Set<string>();
      integrationsByProject.set(r.projectId, set);
    }
    set.add(r.service);
  }

  // When filtering, build the set of project ids that have the
  // requested integration BEFORE projecting the response. We still
  // include every other active integration on the matched projects
  // (so the model sees "DEMO has [agent, capture, github]" not just
  // "DEMO has [capture]") — context matters for follow-up questions.
  const matchedProjectIds = integrationFilter
    ? new Set(
        integrationRows
          .filter((r) => r.service === integrationFilter)
          .map((r) => r.projectId),
      )
    : null;

  // Needs-setup states bubble to the top so users see action items first;
  // remaining rows sort by most-recent activity (or createdAt fallback).
  const NEEDS_SETUP = new Set(["created", "needs_setup", "setting_up"]);
  const projectList = rows
    .filter((r) => !matchedProjectIds || matchedProjectIds.has(r.id))
    .map((r) => ({
      id:             r.id,
      name:           r.name,
      slug:           r.slug,
      state:          r.state,
      framework:      r.framework,
      host:           r.host,
      organizationId: r.organizationId,
      workspaceName:  r.organizationId
        ? (orgNameById.get(r.organizationId) ?? "Workspace")
        : "Personal",
      createdAt:      r.createdAt.toISOString(),
      lastActivityAt: r.lastActivityAt ? r.lastActivityAt.toISOString() : null,
      integrations:   Array.from(integrationsByProject.get(r.id) ?? []).sort(),
    }))
    .sort((a, b) => {
      const aNeeds = NEEDS_SETUP.has(a.state) ? 1 : 0;
      const bNeeds = NEEDS_SETUP.has(b.state) ? 1 : 0;
      if (aNeeds !== bNeeds) return bNeeds - aNeeds;
      const at = a.lastActivityAt ?? a.createdAt;
      const bt = b.lastActivityAt ?? b.createdAt;
      return bt.localeCompare(at);
    });

  return NextResponse.json({ projects: projectList });
}
