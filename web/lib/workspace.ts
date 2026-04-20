import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * Returns the active organization ID for the current user.
 *
 * When `userId` is provided, we skip the session lookup and DB query for
 * callers that already have both pieces in scope (e.g., the dashboard
 * layout reads the users row for plan+verify status; passing `userId`
 * and `activeOrgId` directly avoids a duplicate round-trip).
 */
export async function getActiveOrgId(userId?: string): Promise<string | null> {
  let uid = userId;
  if (!uid) {
    const session = await getServerSession(authOptions);
    uid = (session?.user as { id?: string })?.id;
  }

  if (uid) {
    const [row] = await db
      .select({ activeOrgId: users.activeOrgId })
      .from(users)
      .where(eq(users.id, uid))
      .limit(1);

    return row?.activeOrgId ?? null;
  }

  // Fallback to cookie if no session
  const cookieStore = await cookies();
  return cookieStore.get("activeOrgId")?.value ?? null;
}
