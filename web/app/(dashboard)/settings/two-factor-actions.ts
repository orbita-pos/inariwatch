"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

export async function enableTwoFactor(): Promise<{
  error?: string;
  qrDataUrl?: string;
  secret?: string;
}> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  // Generate a new TOTP secret
  const totp = new OTPAuth.TOTP({
    issuer: "InariWatch",
    label: session?.user?.email ?? "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  const secretBase32 = totp.secret.base32;
  const otpauthUri = totp.toString();

  // Store the secret (not yet enabled — user must verify first)
  await db
    .update(users)
    .set({ totpSecret: secretBase32 })
    .where(eq(users.id, userId));

  // Generate QR code
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
    width: 200,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return { qrDataUrl, secret: secretBase32 };
}

export async function verifyTwoFactor(
  code: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  const [user] = await db
    .select({ totpSecret: users.totpSecret })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.totpSecret) return { error: "No TOTP secret found. Start setup again." };

  const totp = new OTPAuth.TOTP({
    issuer: "InariWatch",
    label: session?.user?.email ?? "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(user.totpSecret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return { error: "Invalid code. Try again." };

  // Enable 2FA
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, userId));

  revalidatePath("/settings");
  return {};
}

export async function disableTwoFactor(): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  await db
    .update(users)
    .set({ twoFactorEnabled: false, totpSecret: null })
    .where(eq(users.id, userId));

  revalidatePath("/settings");
}
