import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function getActiveOrgId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;

  if (userId) {
    const [row] = await db
      .select({ activeOrgId: users.activeOrgId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row?.activeOrgId ?? null;
  }

  // Fallback to cookie if no session
  const cookieStore = await cookies();
  return cookieStore.get("activeOrgId")?.value ?? null;
}
