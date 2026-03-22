import { NextResponse } from "next/server";
import { db, projectIntegrations, projects, users, organizations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { pollPostgres, type PostgresConfig, type PostgresAlertConfig } from "@/lib/pollers/postgres";
import { createAlertIfNew, markIntegrationSuccess } from "@/lib/webhooks/shared";
import { decryptConfig } from "@/lib/crypto";
import type { NewAlert } from "@/lib/db";

import crypto from "crypto";
import { cronLog, pingCronHealth } from "@/lib/cron-utils";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: Request) {
  const start = Date.now();

  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgUsers = alias(users, "orgUsers");
  const projectUsers = alias(users, "projectUsers");

  const integrationsRaw = await db
    .select({
      id:              projectIntegrations.id,
      projectId:       projectIntegrations.projectId,
      service:         projectIntegrations.service,
      configEncrypted: projectIntegrations.configEncrypted,
      errorCount:      projectIntegrations.errorCount,
      lastCheckedAt:   projectIntegrations.lastCheckedAt,
      orgOwnerPlan:    orgUsers.plan,
      projectOwnerPlan: projectUsers.plan,
    })
    .from(projectIntegrations)
    .innerJoin(projects, eq(projectIntegrations.projectId, projects.id))
    .leftJoin(organizations, eq(projects.organizationId, organizations.id))
    .leftJoin(orgUsers, eq(organizations.ownerId, orgUsers.id))
    .leftJoin(projectUsers, eq(projects.userId, projectUsers.id))
    .where(
      and(
        eq(projectIntegrations.isActive, true),
        eq(projectIntegrations.service, "postgres")
      )
    );

  const integrations = integrationsRaw.map((i) => ({
    ...i,
    userPlan: i.orgOwnerPlan ?? i.projectOwnerPlan ?? "free",
  }));

  let created = 0;
  const errors: string[] = [];

  async function pollIntegration(integ: typeof integrations[number]) {
    const cfg = decryptConfig(integ.configEncrypted);
    const connString = cfg.connectionString as string | undefined;
    if (!connString) return [];

    const alertConfig = (cfg.alertConfig ?? {}) as Record<string, unknown>;
    const newAlerts: Omit<NewAlert, "projectId">[] = await pollPostgres(
      { connectionString: connString, name: (cfg.name as string) || "PostgreSQL" } as PostgresConfig,
      alertConfig as PostgresAlertConfig
    );

    await markIntegrationSuccess(integ.id);
    return newAlerts.map((a) => ({ ...a, projectId: integ.projectId }));
  }

  const results = await Promise.allSettled(integrations.map((integ) => pollIntegration(integ)));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const integ = integrations[i];
    if (result.status === "fulfilled") {
      for (const { projectId, ...alert } of result.value) {
        const inserted = await createAlertIfNew(alert, projectId);
        if (inserted) {
          created++;
        }
      }
    } else {
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`postgres/${integ.id}: ${errMsg}`);
      db.update(projectIntegrations)
        .set({ lastCheckedAt: new Date(), errorCount: (integ.errorCount ?? 0) + 1 })
        .where(eq(projectIntegrations.id, integ.id))
        .catch(() => {});
    }
  }

  const duration_ms = Date.now() - start;
  cronLog("poll_postgres", {
    created,
    integrations: integrations.length,
    errors: errors.length,
    duration_ms,
  });
  await pingCronHealth("poll_postgres", errors.length === 0);

  return NextResponse.json({ ok: true, created, errors });
}
