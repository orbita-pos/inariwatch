import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, users, emailVerifications } = await import("../lib/db");
  const { sql, desc, eq } = await import("drizzle-orm");

  console.log("=== 5 most recent users ===");
  const recent = await db
    .select({
      id: users.id,
      email: users.email,
      hasPassword: sql<boolean>`${users.passwordHash} is not null`,
      verifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(5);

  for (const u of recent) {
    const maskedEmail = u.email.replace(/^(.{3}).+(@.+)$/, "$1***$2");
    const secs = Math.round((Date.now() - u.createdAt.getTime()) / 1000);
    const age = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.round(secs / 60)}m` : `${Math.round(secs / 3600)}h`;
    console.log(`  ${maskedEmail.padEnd(30)} ${u.hasPassword ? "pwd" : "oauth"} ${u.verifiedAt ? "VERIFIED" : "UNVERIFIED"} ${age}`);

    // Count verification attempts for this user
    const attempts = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, u.id));
    console.log(`    emailVerifications rows: ${attempts[0].n}`);
  }

  console.log("\n=== total emailVerifications table rows ===");
  const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(emailVerifications);
  console.log(`  ${total.n}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
