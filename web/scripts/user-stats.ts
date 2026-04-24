import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, users, organizations, projects, accounts } = await import("../lib/db");
  const { sql, gte, desc } = await import("drizzle-orm");

  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const d1 = new Date(now.getTime() - 24 * 3600 * 1000);

  const [totalUsers] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [verifiedUsers] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.emailVerifiedAt} is not null`);
  const [last24h] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(gte(users.createdAt, d1));
  const [last7d] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(gte(users.createdAt, d7));
  const [last30d] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(gte(users.createdAt, d30));

  const [totalOrgs] = await db.select({ n: sql<number>`count(*)::int` }).from(organizations);
  const [totalProjects] = await db.select({ n: sql<number>`count(*)::int` }).from(projects);

  console.log("=== InariWatch user stats ===");
  console.log(`Total users          : ${totalUsers.n}`);
  console.log(`  email verified     : ${verifiedUsers.n}`);
  console.log(`  registered 24h     : ${last24h.n}`);
  console.log(`  registered 7d      : ${last7d.n}`);
  console.log(`  registered 30d     : ${last30d.n}`);
  console.log(`Organizations        : ${totalOrgs.n}`);
  console.log(`Projects             : ${totalProjects.n}`);

  console.log("\n=== 10 most recent users ===");
  const recent = await db
    .select({
      email: users.email,
      hasPassword: sql<boolean>`${users.passwordHash} is not null`,
      verifiedAt: users.emailVerifiedAt,
      plan: users.plan,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(10);

  for (const u of recent) {
    const maskedEmail = u.email.replace(/^(.{2}).+(@.+)$/, "$1***$2");
    const oauth = u.hasPassword ? "pwd " : "oauth";
    const verified = u.verifiedAt ? "verified" : "UNVERIFIED";
    const mins = Math.round((Date.now() - u.createdAt.getTime()) / 60000);
    const age = mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins/60)}h ago` : `${Math.round(mins/1440)}d ago`;
    console.log(`  ${maskedEmail.padEnd(28)} ${oauth} ${verified.padEnd(11)} ${u.plan.padEnd(6)} ${age}`);
  }

  console.log("\n=== OAuth accounts linked ===");
  const providerCounts = await db
    .select({ provider: accounts.provider, n: sql<number>`count(*)::int` })
    .from(accounts)
    .groupBy(accounts.provider);
  if (providerCounts.length === 0) {
    console.log("  (none)");
  } else {
    for (const p of providerCounts) {
      console.log(`  ${p.provider.padEnd(10)} : ${p.n}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
