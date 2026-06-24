"use server";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users, organizationMembers, organizations } from "@/lib/db";
import { eq, and } from "drizzle-orm";

export async function switchWorkspace(orgId: string | null): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  if (orgId !== null) {
    const [member] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);

    const [owned] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.ownerId, userId)))
      .limit(1);

    if (!member && !owned) return;
  }

  // Save to DB — syncs across devices
  await db.update(users)
    .set({ activeOrgId: orgId, updatedAt: new Date() })
    .where(eq(users.id, userId));

  // Also set cookie for instant response without extra DB query
  const cookieStore = await cookies();
  if (orgId === null) {
    cookieStore.delete("activeOrgId");
  } else {
    cookieStore.set("activeOrgId", orgId, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
  }
}
