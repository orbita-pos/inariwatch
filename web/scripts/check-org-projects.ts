import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, projects, projectIntegrations, users } = await import("../lib/db");
  const { eq } = await import("drizzle-orm");

  const BERNAL_ORG = "f4b0ed46-aab2-4d2b-aa0d-e8c0ae37f5f7";
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, BERNAL_ORG));

  console.log(`Projects in BERNAL ORG: ${rows.length}\n`);
  for (const p of rows) {
    const [owner] = p.userId
      ? await db.select({ email: users.email }).from(users).where(eq(users.id, p.userId)).limit(1)
      : [undefined];
    console.log(`  ${p.slug.padEnd(30)} (${p.id.slice(0,8)}…)  userId=${p.userId?.slice(0,8) ?? "null"}…  owner=${owner?.email ?? "(none)"}`);

    const integs = await db
      .select({ id: projectIntegrations.id, service: projectIntegrations.service, isActive: projectIntegrations.isActive })
      .from(projectIntegrations)
      .where(eq(projectIntegrations.projectId, p.id));
    for (const i of integs) {
      console.log(`    ${i.id.slice(0,8)}… ${i.service.padEnd(12)} active=${i.isActive}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
