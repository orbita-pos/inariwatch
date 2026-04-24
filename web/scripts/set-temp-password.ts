import { config } from "dotenv";
config({ path: ".env.local" });
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

/**
 * Set a temporary bcrypt password on a user row so the owner can log in
 * via email+password during the Hetzner parallel-run smoke test — the
 * OAuth callback URLs are still bound to the Vercel hostname until the
 * DNS cutover, so Google / GitHub login can't round-trip through
 * app-new.inariwatch.com yet.
 *
 *   npx tsx scripts/set-temp-password.ts <email>
 *   npx tsx scripts/set-temp-password.ts <email> --clear
 *
 * --clear nulls the passwordHash back out. Run that immediately after
 * the smoke test finishes, or after rotating to a real password via
 * Settings.
 */
async function main() {
  const { neon } = await import("@neondatabase/serverless");
  const email = process.argv[2]?.trim().toLowerCase();
  const clear = process.argv.includes("--clear");

  if (!email || !email.includes("@")) {
    console.error("Usage: npx tsx scripts/set-temp-password.ts <email> [--clear]");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL missing in .env.local");
    process.exit(1);
  }
  const sql = neon(url);

  // Confirm user exists.
  const rows = (await sql`SELECT id, email FROM users WHERE LOWER(email) = ${email} LIMIT 1`) as Array<{
    id: string;
    email: string;
  }>;
  const user = rows[0];
  if (!user) {
    console.error(`No user found for ${email}`);
    process.exit(1);
  }

  if (clear) {
    await sql`UPDATE users SET password_hash = NULL WHERE id = ${user.id}`;
    console.log(`OK — password_hash cleared for ${user.email} (${user.id})`);
    process.exit(0);
  }

  // Generate a readable-but-strong temp password. 12 chars of base64 ≈ 72 bits
  // of entropy, well above bcrypt's compression floor and above the 8-char
  // minimum the register action enforces.
  const pw = randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
  const hash = await bcrypt.hash(pw, 12);

  await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${user.id}`;

  console.log("");
  console.log(`  user:     ${user.email} (${user.id})`);
  console.log(`  password: ${pw}`);
  console.log("");
  console.log("Log in, smoke test, then clear with:");
  console.log(`  npx tsx scripts/set-temp-password.ts ${user.email} --clear`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
