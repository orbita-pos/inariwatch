"use server";

import { randomBytes } from "crypto";
import { db, users, passwordResetTokens } from "@/lib/db";
import { eq } from "drizzle-orm";
import { sendEmail } from "@/lib/notifications/email";
import { rateLimit } from "@/lib/auth-rate-limit";

export async function requestPasswordReset(
  formData: FormData
): Promise<{ success: boolean; error?: string }> {
  const email = formData.get("email") as string | null;
  if (!email || !email.includes("@")) {
    return { success: false, error: "Please enter a valid email address." };
  }

  // Rate limit: 3 reset requests per email per 15 minutes
  const rl = rateLimit("password-reset", email.toLowerCase(), {
    windowMs: 15 * 60_000,
    max: 3,
  });
  if (!rl.allowed) {
    // Still return success to not leak timing info
    return { success: true };
  }

  // Look up user — if not found, still return success (don't leak existence)
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);

  if (!user) {
    return { success: true };
  }

  // Generate token
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.insert(passwordResetTokens).values({
    userId: user.id,
    token,
    expiresAt,
  });

  // Send email
  const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail(
    { email: user.email },
    "InariWatch — Reset your password",
    `
    <div style="background-color: #09090b; padding: 40px 0;">
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <span style="font-family: monospace; font-size: 20px; font-weight: bold; color: #7C3AED;">&#9673;</span>
          <span style="font-family: monospace; font-size: 14px; font-weight: bold; color: #fff; letter-spacing: 4px; margin-left: 8px; text-transform: uppercase;">KAIRO</span>
        </div>
        <h2 style="color: #fff; font-size: 18px; margin-bottom: 16px; text-align: center;">Reset your password</h2>
        <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; text-align: center;">
          We received a request to reset the password for your InariWatch account. Click the button below to choose a new password.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}" style="display: inline-block; background-color: #7C3AED; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 32px; border-radius: 8px;">
            Reset password
          </a>
        </div>
        <p style="color: #52525b; font-size: 12px; text-align: center; line-height: 1.6;">
          This link expires in 1 hour. If you didn&rsquo;t request a password reset, you can safely ignore this email.
        </p>
      </div>
    </div>
    `
  );

  return { success: true };
}
