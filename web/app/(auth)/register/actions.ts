"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { rateLimit } from "@/lib/auth-rate-limit";
import { extractClientIp } from "@/lib/webhooks/rate-limit";
import { isDisposableEmail } from "@/lib/auth/disposable-emails";

export async function registerUser(
  formData: FormData
): Promise<{ success: boolean; error?: string }> {
  const email    = (formData.get("email")    as string)?.toLowerCase().trim();
  const name     = (formData.get("name")     as string)?.trim();
  const password = formData.get("password")  as string;

  if (!email || !email.includes("@")) {
    return { success: false, error: "Please enter a valid email address." };
  }
  if (!password || password.length < 8) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  // IP rate limit BEFORE the email rate limit — stops distributed signup
  // spam where each request uses a fresh email. extractClientIp uses
  // x-real-ip (set by Vercel, can't be spoofed) with x-forwarded-for fallback.
  const h = await headers();
  const ip = extractClientIp({ headers: h } as unknown as Request);
  const ipRl = await rateLimit("register-ip", ip, {
    windowMs: 24 * 60 * 60_000,
    max: 3,
  });
  if (!ipRl.allowed) {
    return { success: false, error: "Too many attempts. Try again tomorrow." };
  }

  // Block disposable / throwaway email services. Static list + env override
  // (DISPOSABLE_EMAIL_OVERRIDES=domain1,domain2,...).
  if (isDisposableEmail(email)) {
    return { success: false, error: "Please use a permanent email address." };
  }

  // Email rate limit (existing): 5 registrations per email per hour
  const rl = await rateLimit("register", email, { windowMs: 60 * 60_000, max: 5 });
  if (!rl.allowed) {
    return { success: false, error: "Too many attempts. Try again later." };
  }

  // Check if email already exists. We do NOT leak this fact in the response —
  // returning a distinct "already exists" message is an enumeration oracle
  // (attackers can probe which addresses have accounts). Both the new-account
  // and existing-account paths return the same generic success message.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    // Return success-shaped response without actually creating the account.
    // Caller will redirect to the login page where the existing user can
    // reset their password if they forgot it.
    return { success: true };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.insert(users).values({
    email,
    name: name || null,
    passwordHash,
  });

  return { success: true };
}
