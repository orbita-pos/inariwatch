import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, users } = await import("../lib/db");
  const { accounts } = await import("../lib/db/schema");
  const { eq, or } = await import("drizzle-orm");

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
      activeOrgId: users.activeOrgId,
    })
    .from(users)
    .where(eq(users.email, "bernal.rojas.dev@gmail.com"));

  console.log(`Users matching bernal.rojas.dev@gmail.com: ${rows.length}\n`);
  for (const u of rows) {
    console.log(`  id:             ${u.id}`);
    console.log(`  email:          ${u.email}`);
    console.log(`  name:           ${u.name ?? "(null)"}`);
    console.log(`  emailVerifiedAt: ${u.emailVerifiedAt ? u.emailVerifiedAt.toISOString() : "(null)"}`);
    console.log(`  createdAt:       ${u.createdAt?.toISOString?.() ?? u.createdAt}`);
    console.log(`  activeOrgId:     ${u.activeOrgId ?? "(null)"}`);

    const accs = await db
      .select({ provider: accounts.provider, type: accounts.type })
      .from(accounts)
      .where(eq(accounts.userId, u.id));
    console.log(`  accounts:       ${accs.map((a) => `${a.provider}(${a.type})`).join(", ") || "(none — credentials)"}`);
    console.log("");
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
