"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { cliPendingCodes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

export async function approveCliCode(formData: FormData) {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/auth/signin");

  const code = (formData.get("code") as string | null)?.trim();
  if (!code) return;

  const [pending] = await db
    .select()
    .from(cliPendingCodes)
    .where(eq(cliPendingCodes.code, code))
    .limit(1);

  if (!pending || pending.approved || new Date() > pending.expiresAt) return;

  await db
    .update(cliPendingCodes)
    .set({ approved: true, userId })
    .where(eq(cliPendingCodes.code, code));
}
