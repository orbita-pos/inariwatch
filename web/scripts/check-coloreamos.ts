import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { projects, users, projectIntegrations, alerts } = await import("../lib/db");
  const { eq, sql, gte, desc } = await import("drizzle-orm");

  const [proj] = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      userId: projects.userId,
      organizationId: projects.organizationId,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.slug, "coloreamos-mobile"))
    .limit(1);

  if (!proj) { console.log("project not found"); process.exit(0); }
  console.log(`Project: ${proj.name} (${proj.slug})`);
  console.log(`  id:         ${proj.id}`);
  console.log(`  userId:     ${proj.userId}`);
  console.log(`  orgId:      ${proj.organizationId ?? "(none)"}`);
  console.log(`  createdAt:  ${proj.createdAt?.toISOString()}`);

  const [u] = await db
    .select({ id: users.id, email: users.email, name: users.name, plan: users.plan, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, proj.userId))
    .limit(1);
  console.log(`\nOwner:`);
  console.log(`  email:      ${u?.email}`);
  console.log(`  name:       ${u?.name}`);
  console.log(`  plan:       ${u?.plan}`);
  console.log(`  created:    ${u?.createdAt?.toISOString()}`);

  const integs = await db.select({ service: projectIntegrations.service, isActive: projectIntegrations.isActive, createdAt: projectIntegrations.createdAt }).from(projectIntegrations).where(eq(projectIntegrations.projectId, proj.id));
  console.log(`\nIntegrations (${integs.length}):`);
  for (const i of integs) {
    console.log(`  ${i.service.padEnd(10)}  active=${i.isActive}  created=${i.createdAt?.toISOString()?.slice(0, 10)}`);
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const alertRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(alerts)
    .where(sql`${alerts.projectId} = ${proj.id} AND ${alerts.createdAt} >= ${since}`);
  console.log(`\nAlerts last 30d:  ${alertRows[0]?.count ?? 0}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
