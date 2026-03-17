import { randomBytes } from "crypto";
import { db, emailVerifications, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { sendEmail } from "@/lib/notifications/email";

/**
 * Sends an email verification link to the given user.
 * Inserts a token into `emailVerifications` with 24-hour expiry and
 * emails the user a link to `/api/auth/verify-email?token=...`.
 */
export async function sendVerificationEmail(
  userId: string,
  email: string
): Promise<{ ok: boolean; error?: string }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await db.insert(emailVerifications).values({
    userId,
    token,
    expiresAt,
  });

  const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;

  const result = await sendEmail(
    { email },
    "InariWatch — Verify your email address",
    `
    <div style="background-color: #09090b; padding: 40px 0;">
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <span style="font-family: monospace; font-size: 20px; font-weight: bold; color: #7C3AED;">&#9673;</span>
          <span style="font-family: monospace; font-size: 14px; font-weight: bold; color: #fff; letter-spacing: 4px; margin-left: 8px; text-transform: uppercase;">KAIRO</span>
        </div>
        <h2 style="color: #fff; font-size: 18px; margin-bottom: 16px; text-align: center;">Verify your email address</h2>
        <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; text-align: center;">
          Click the button below to verify your email and activate your InariWatch account.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${verifyUrl}" style="display: inline-block; background-color: #7C3AED; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 32px; border-radius: 8px;">
            Verify email
          </a>
        </div>
        <p style="color: #52525b; font-size: 12px; text-align: center; line-height: 1.6;">
          This link expires in 24 hours. If you didn&rsquo;t create a InariWatch account, you can safely ignore this email.
        </p>
      </div>
    </div>
    `
  );

  return result;
}
