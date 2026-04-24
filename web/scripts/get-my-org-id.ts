import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { organizations, organizationMembers, users } = await import("../lib/db");
  const { eq } = await import("drizzle-orm");

  const email = "bernal.rojas.dev@gmail.com";
  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    console.error(`User ${email} not found`);
    process.exit(1);
  }

  const owned = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.ownerId, user.id));

  const memberships = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, user.id));

  console.log(`User: ${user.name ?? "(no name)"} <${email}>`);
  console.log(`User ID: ${user.id}\n`);
  console.log(`Organizations owned (${owned.length}):`);
  for (const o of owned) console.log(`  ${o.id}  ${o.slug.padEnd(20)} "${o.name}"`);
  console.log(`\nMemberships (${memberships.length}):`);
  for (const o of memberships) console.log(`  ${o.id}  ${o.slug.padEnd(20)} "${o.name}"`);

  if (owned.length > 0) {
    console.log(`\n→ Suggested PREVIEW_FIX_ORGS value (first owned org):`);
    console.log(`  PREVIEW_FIX_ORGS=${owned[0].id}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
