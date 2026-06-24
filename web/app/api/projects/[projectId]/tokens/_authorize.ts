/**
 * Auth helper for project token routes (Inari Live V1 — Session 2).
 *
 * Mirrors the `authorizeProject` helper in
 * `web/app/(dashboard)/projects/[slug]/capture-actions.ts:20`. Pulled into
 * its own module because the API routes are split across two folders
 * (the projectId level and the projectId/tokens/[tokenId] level) and
 * duplicating the org-membership lookup would be a bug magnet.
 *
 * Session 3 — additive Bearer fallback: when no NextAuth session is
 * present we try `authenticateExtensionToken` so Inari Live desktop
 * can call mint with its device token. The session fast-path is
 * unchanged — every existing S2 caller behaves identically. Bearer
 * callers go through the same project-ownership check (owner/org
 * membership) so authorization is identical regardless of the auth
 * mode used to identify `userId`.
 */

import { getServerSession } from "next-auth";
import { headers as nextHeaders } from "next/headers";
import { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import { and, eq } from "drizzle-orm";
import {
  db,
  projects,
  organizations,
  organizationMembers,
} from "@/lib/db";
import { authenticateExtensionToken } from "@/lib/auth-extension";

export type AuthorizedProject = {
  ok: true;
  userId: string;
  projectId: string;
  /** workspace_id for project_tokens.workspace_id — null for personal projects. */
  workspaceId: string | null;
};

export type AuthFailure = { ok: false; status: 401 | 403 | 404; error: string };

/**
 * Authorize the current session to act on `projectId`. Returns the project's
 * workspace (organization) id so callers don't have to re-query.
 */
export async function authorizeProjectForTokens(
  projectId: string,
): Promise<AuthorizedProject | AuthFailure> {
  if (!isUuid(projectId)) {
    return { ok: false, status: 400 as const as 404, error: "Invalid project id" };
  }

  const session = await getServerSession(authOptions);
  let userId = (session?.user as { id?: string } | undefined)?.id;

  // S3 desktop wizard fallback — only consulted when NextAuth gave us
  // nothing. The Bearer path requires a request-scoped headers() call,
  // so we synthesize a NextRequest only for the auth-extension lookup.
  if (!userId) {
    const fromBearer = await authenticateFromBearer();
    if (fromBearer) userId = fromBearer;
  }

  if (!userId) {
    return { ok: false, status: 401, error: "You need to be signed in." };
  }

  const [project] = await db
    .select({
      userId:         projects.userId,
      organizationId: projects.organizationId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return { ok: false, status: 404, error: "Project not found." };
  }

  // Owner of the project — full access.
  if (project.userId === userId) {
    return {
      ok: true,
      userId,
      projectId,
      workspaceId: project.organizationId,
    };
  }

  // Org-owned project — owner + admin members can manage tokens.
  if (project.organizationId) {
    const [orgRow] = await db
      .select({ ownerId: organizations.ownerId })
      .from(organizations)
      .where(eq(organizations.id, project.organizationId))
      .limit(1);
    if (orgRow?.ownerId === userId) {
      return {
        ok: true,
        userId,
        projectId,
        workspaceId: project.organizationId,
      };
    }

    const [member] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, project.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    if (member && (member.role === "owner" || member.role === "admin")) {
      return {
        ok: true,
        userId,
        projectId,
        workspaceId: project.organizationId,
      };
    }
  }

  return { ok: false, status: 403, error: "You're not authorized to manage this project." };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Best-effort Bearer auth for desktop callers. Reuses
 * `authenticateExtensionToken`, which already handles both S1 device
 * tokens and the legacy `api_keys.service='desktop'` fallback. Returns
 * the userId on match, null otherwise — caller decides 401 vs. 403.
 *
 * The function reaches for `next/headers` so it stays usable from a
 * Server Action (no NextRequest available there). When called from a
 * route handler, the headers proxy resolves to the in-flight request's
 * headers without any extra plumbing.
 */
async function authenticateFromBearer(): Promise<string | null> {
  let auth: string | null;
  try {
    const h = await nextHeaders();
    auth = h.get("authorization");
  } catch {
    // headers() throws when called outside a request scope (e.g. unit
    // tests that import this module without mocking next/headers).
    return null;
  }
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  // authenticateExtensionToken expects a NextRequest — synthesize one
  // with just the Authorization header so it can run its hash lookup.
  const fakeReq = new NextRequest("http://localhost/internal/bearer-check", {
    headers: { authorization: auth },
  });
  const result = await authenticateExtensionToken(fakeReq);
  return result?.userId ?? null;
}
