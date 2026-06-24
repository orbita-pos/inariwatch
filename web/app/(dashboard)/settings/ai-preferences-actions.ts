"use server";

// v0.3 S3 — server actions for the AI Preferences settings card.
//
// Currently exposes a single toggle: `localNotifyEnabled`. When ON, the
// router routes `notify.compose.email` dispatches to the workspace
// owner's Inari Live (user-sidecar) instead of cloud. Default OFF keeps
// existing customers on cloud until they opt in.
//
// `taskOverrides` and `forceCloudOnly` from `WorkspacePreferences` are
// admin-only (no UI yet); add server actions here when those grow UIs.

import { revalidatePath } from "next/cache";
import { getServerSession } from "next-auth";
import { eq } from "drizzle-orm";

import { authOptions } from "@/lib/auth";
import { db, organizations, organizationMembers, users } from "@/lib/db";

interface SessionUser {
  id?: string;
}

async function resolveActiveOrgId(userId: string): Promise<string | null> {
  // Users have an `activeOrgId` set by the workspace switcher. If unset
  // (e.g. solo workspace, no switcher use), fall back to the user's
  // first org membership — same heuristic the rest of the app uses.
  const userRow = await db
    .select({ activeOrgId: users.activeOrgId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (userRow[0]?.activeOrgId) return userRow[0].activeOrgId;
  const member = await db
    .select({ orgId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .limit(1);
  return member[0]?.orgId ?? null;
}

export async function setLocalNotifyEnabled(
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as SessionUser | undefined)?.id;
  if (!userId) {
    return { ok: false, error: "not authenticated" };
  }
  const orgId = await resolveActiveOrgId(userId);
  if (!orgId) {
    return { ok: false, error: "no active workspace" };
  }
  await db
    .update(organizations)
    .set({ localNotifyEnabled: enabled })
    .where(eq(organizations.id, orgId));
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * v0.3 S5 — toggles `voice.tts.*` routing to Inari Live (Piper). Separate
 * action from `setLocalNotifyEnabled` so the toggles in the UI map 1:1 to
 * server effects. The router (`packages/ai-router/src/rules.ts`) reads
 * this flag against the rule's `workspaceFlag: "localVoiceEnabled"`.
 */
export async function setLocalVoiceEnabled(
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as SessionUser | undefined)?.id;
  if (!userId) {
    return { ok: false, error: "not authenticated" };
  }
  const orgId = await resolveActiveOrgId(userId);
  if (!orgId) {
    return { ok: false, error: "no active workspace" };
  }
  await db
    .update(organizations)
    .set({ localVoiceEnabled: enabled })
    .where(eq(organizations.id, orgId));
  revalidatePath("/settings");
  return { ok: true };
}
