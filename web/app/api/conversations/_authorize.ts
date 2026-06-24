/**
 * Auth helper for conversation API routes — Inari Live V1 Session 5.
 *
 * Mirrors `app/api/projects/[projectId]/tokens/_authorize.ts` shape:
 *   * NextAuth session → fast path for the dashboard.
 *   * Authorization: Bearer <device-token> → fallback for Inari Live
 *     desktop and any other API client.
 *
 * Conversations are workspace-scoped, not per-project, so this helper
 * resolves the user's *active* organization (set during sign-in or via
 * `/api/active-org`). For users without an active org we return a
 * `workspaceId: null`, which the service layer treats as "single-org
 * legacy install" — same posture as `getActiveOrgId()` callers across
 * the dashboard.
 */

import { getServerSession } from "next-auth";
import { headers as nextHeaders } from "next/headers";
import { NextRequest } from "next/server";

import { authOptions } from "@/lib/auth";
import { authenticateExtensionToken } from "@/lib/auth-extension";
import { getActiveOrgId } from "@/lib/workspace";

export type AuthorizedConversationCtx = {
  ok: true;
  userId: string;
  workspaceId: string | null;
  /** Tagged so audit attribution distinguishes session vs Bearer requests. */
  authMode: "session" | "bearer";
};

export type AuthFailure = { ok: false; status: 401 | 403 | 404; error: string };

export async function authorizeConversationCtx(): Promise<AuthorizedConversationCtx | AuthFailure> {
  const session = await getServerSession(authOptions);
  let userId = (session?.user as { id?: string } | undefined)?.id;
  let authMode: AuthorizedConversationCtx["authMode"] = "session";

  if (!userId) {
    const fromBearer = await authenticateFromBearer();
    if (fromBearer) {
      userId = fromBearer;
      authMode = "bearer";
    }
  }

  if (!userId) {
    return { ok: false, status: 401, error: "You need to be signed in." };
  }

  const workspaceId = await getActiveOrgId().catch(() => null);
  return { ok: true, userId, workspaceId, authMode };
}

async function authenticateFromBearer(): Promise<string | null> {
  let auth: string | null;
  try {
    const h = await nextHeaders();
    auth = h.get("authorization");
  } catch {
    return null;
  }
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  const fakeReq = new NextRequest("http://localhost/internal/bearer-check", {
    headers: { authorization: auth },
  });
  const result = await authenticateExtensionToken(fakeReq);
  return result?.userId ?? null;
}
