"use server";

import bcrypt from "bcryptjs";
import { db, users, passwordResetTokens } from "@/lib/db";
import { eq, and, isNull, gt } from "drizzle-orm";

export async function resetPassword(
  formData: FormData
): Promise<{ success: boolean; error?: string }> {
  const start = Date.now();

  const token = formData.get("token") as string | null;
  const password = formData.get("password") as string | null;
  const confirmPassword = formData.get("confirmPassword") as string | null;

  if (!token) {
    return { success: false, error: "Missing reset token." };
  }

  if (!password || password.length < 8) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  if (password !== confirmPassword) {
    return { success: false, error: "Passwords do not match." };
  }

  // Find the token — must exist, not expired, not already used
  const [resetToken] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.token, token),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!resetToken) {
    // Constant-time jitter: normalize response time to prevent timing attacks
    const elapsed = Date.now() - start;
    if (elapsed < 200) await new Promise(r => setTimeout(r, 200 - elapsed + Math.random() * 50));
    return { success: false, error: "Invalid or expired reset link. Please request a new one." };
  }

  // Hash the new password
  const passwordHash = await bcrypt.hash(password, 12);

  // Update user's password
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, resetToken.userId));

  // Mark token as used
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, resetToken.id));

  return { success: true };
}
