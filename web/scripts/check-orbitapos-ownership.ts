import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, projects, users, organizations, projectIntegrations } = await import("../lib/db");
  const { eq } = await import("drizzle-orm");

  const [p] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, "orbitapos"))
    .limit(1);
  if (!p) { console.log("orbitapos not found"); process.exit(0); }

  console.log(`project.id:             ${p.id}`);
  console.log(`project.userId:         ${p.userId ?? "(null)"}`);
  console.log(`project.organizationId: ${p.organizationId ?? "(null)"}`);

  if (p.userId) {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, p.userId)).limit(1);
    console.log(`owner email:            ${u?.email ?? "(not found)"}`);
  }
  if (p.organizationId) {
    const [o] = await db.select({ name: organizations.name, ownerId: organizations.ownerId }).from(organizations).where(eq(organizations.id, p.organizationId)).limit(1);
    console.log(`org name:               ${o?.name ?? "(not found)"}`);
    console.log(`org.ownerId:            ${o?.ownerId ?? "(null)"}`);
  }

  const integs = await db
    .select({ id: projectIntegrations.id, service: projectIntegrations.service, isActive: projectIntegrations.isActive })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.projectId, p.id));
  console.log(`integrations:           ${integs.length}`);
  for (const i of integs) console.log(`  ${i.id.slice(0,8)}… ${i.service} active=${i.isActive}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
