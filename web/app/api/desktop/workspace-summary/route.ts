import { NextRequest, NextResponse } from "next/server";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";
import {
  db,
  projects,
  getUserOrganizations,
  getWorkspaceProjectIds,
} from "@/lib/db";
import { getWorkspaceSummary } from "@/lib/services/desktop-widgets.service";

/**
 * GET /api/desktop/workspace-summary
 *
 * Read-only dashboard one-liner consumed by the desktop chat agent's
 * `cloud.get_workspace_summary` tool. The LLM calls this when the user
 * asks an open-ended workspace question ("how are things?", "anything
 * on fire?") so the agent can answer without N alert/uptime/on-call
 * round-trips.
 *
 * Auth: desktop bearer token. The summary is scoped to every project
 * the calling user can see across personal + every org they belong to —
 * same visibility rules as `/api/desktop/projects`.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  // Resolve visible project ids the same way `/api/desktop/projects` does
  // so the summary lines up exactly with what the agent saw when it
  // called `cloud.list_projects` before this.
  const orgs = await getUserOrganizations(auth.userId);
  const idLists = await Promise.all([
    getWorkspaceProjectIds(auth.userId, null),
    ...orgs.map((o) => getWorkspaceProjectIds(auth.userId, o.id)),
  ]);
  const visibleIds = Array.from(new Set(idLists.flat()));
  // `db` and `projects` are used implicitly via `getWorkspaceSummary`'s
  // helpers; the imports stay so this handler is a single-file deploy
  // surface (no hidden coupling).
  void db;
  void projects;

  const summary = await getWorkspaceSummary(visibleIds);
  return NextResponse.json(summary);
}
