"use server";

import bcrypt from "bcryptjs";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { rateLimit } from "@/lib/auth-rate-limit";

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

  // Rate limit: 5 registrations per IP-ish (keyed by email prefix) per hour
  const rl = await rateLimit("register", email, { windowMs: 60 * 60_000, max: 5 });
  if (!rl.allowed) {
    return { success: false, error: "Too many attempts. Try again later." };
  }

  // Check if email already exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    return { success: false, error: "An account with this email already exists." };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.insert(users).values({
    email,
    name: name || null,
    passwordHash,
  });

  return { success: true };
}
