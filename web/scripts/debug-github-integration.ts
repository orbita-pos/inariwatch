import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Debug why Preview Fix says "No GitHub integration for project" when
 * the user believes GitHub is connected. Queries projectIntegrations for
 * all rows tied to the drift-demo project + bernal.rojas.dev's account.
 */
async function main() {
  const { db, projectIntegrations, projects, users } = await import("../lib/db");
  const { eq } = await import("drizzle-orm");

  // drift-demo alert was d0e9e62e — let's get that project
  const email = "bernal.rojas.dev@gmail.com";
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    console.error(`User ${email} not found`);
    process.exit(1);
  }

  const userProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.userId, user.id));

  console.log(`\nProjects owned by ${email}:\n`);
  for (const p of userProjects) {
    const integrations = await db
      .select({
        id: projectIntegrations.id,
        service: projectIntegrations.service,
        isActive: projectIntegrations.isActive,
        createdAt: projectIntegrations.createdAt,
      })
      .from(projectIntegrations)
      .where(eq(projectIntegrations.projectId, p.id));

    console.log(`  ${p.slug.padEnd(40)} (${p.id.slice(0, 8)}…)  "${p.name}"`);
    if (integrations.length === 0) {
      console.log(`    integrations: (none)`);
    } else {
      for (const i of integrations) {
        const active = i.isActive ? "✓ active" : "✗ inactive";
        console.log(`    ${i.service.padEnd(12)} ${active}  (${i.createdAt.toISOString().slice(0, 10)})`);
      }
    }
    console.log("");
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
