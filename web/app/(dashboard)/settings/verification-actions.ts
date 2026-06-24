"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { sendVerificationEmail } from "@/lib/auth/send-verification";

export async function resendVerificationEmail(): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return { error: "User not found." };

  // Don't resend if already verified
  if (user.emailVerifiedAt) return { error: "Email is already verified." };

  // Only for credentials users
  if (!user.passwordHash) return { error: "OAuth accounts do not need email verification." };

  const result = await sendVerificationEmail(userId, user.email);
  if (!result.ok) return { error: result.error ?? "Failed to send verification email." };

  return {};
}
