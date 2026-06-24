import { NextResponse } from "next/server";
import { db, projectIntegrations, projects, users, organizations, shouldPollThisCycle } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { pollExpo, type ExpoAlertConfig } from "@/lib/pollers/expo";
import { createAlertIfNew, markIntegrationSuccess } from "@/lib/webhooks/shared";
import { decryptConfig } from "@/lib/crypto";
import type { NewAlert } from "@/lib/db";

import crypto from "crypto";
import { cronLog, pingCronHealth, settleWithConcurrency } from "@/lib/cron-utils";

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
        eq(projectIntegrations.service, "expo")
      )
    );

  const integrations = integrationsRaw
    .map((i) => ({
      ...i,
      userPlan: i.orgOwnerPlan ?? i.projectOwnerPlan ?? "free",
    }))
    // Free plan: throttle to once per 5 min to limit upstream Expo API spend.
    .filter((i) => shouldPollThisCycle(i.userPlan, i.lastCheckedAt));

  let created = 0;
  const errors: string[] = [];

  async function pollIntegration(integ: typeof integrations[number]) {
    const cfg = decryptConfig(integ.configEncrypted);
    const token = cfg.token as string | undefined;
    if (!token) return [];

    const alertConfig = (cfg.alertConfig ?? {}) as Record<string, unknown>;
    const newAlerts: Omit<NewAlert, "projectId">[] = await pollExpo(
      token,
      alertConfig as ExpoAlertConfig
    );

    await markIntegrationSuccess(integ.id);
    return newAlerts.map((a) => ({ ...a, projectId: integ.projectId }));
  }

  // Concurrency-limited fan-out (10 parallel) to bound upstream Expo API calls.
  const results = await settleWithConcurrency(integrations, 10, pollIntegration);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const integ = integrations[i];
    if (result.status === "fulfilled") {
      for (const { projectId, ...alert } of result.value) {
        const inserted = await createAlertIfNew(alert, projectId);
        if (inserted) created++;
      }
    } else {
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`expo/${integ.id}: ${errMsg}`);
      db.update(projectIntegrations)
        .set({ lastCheckedAt: new Date(), errorCount: (integ.errorCount ?? 0) + 1 })
        .where(eq(projectIntegrations.id, integ.id))
        .catch(() => {});
    }
  }

  const duration_ms = Date.now() - start;
  cronLog("poll_expo", { created, integrations: integrations.length, errors: errors.length, duration_ms });
  await pingCronHealth("poll_expo", errors.length === 0);

  return NextResponse.json({ ok: true, created, errorCount: errors.length });
}
