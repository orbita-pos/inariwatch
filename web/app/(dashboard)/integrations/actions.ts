"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectIntegrations, users, PLAN_LIMITS } from "@/lib/db";
import { eq, and, count } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generateWebhookSecret } from "@/lib/webhooks/shared";
import { logAudit } from "@/lib/audit";
import { encrypt, encryptConfig, decryptConfig } from "@/lib/crypto";
import { validatePublicUrl } from "@/lib/url-validation";

// ── Token validation + auto-discovery ────────────────────────────────────────

async function resolveConfig(
  service: string,
  token: string
): Promise<{ config: Record<string, string>; error?: string }> {

  if (service === "github") {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "InariWatch-Monitor/1.0" },
    });
    if (res.status === 401) return { config: {}, error: "Invalid GitHub token — check that it has Contents + Metadata read access." };
    if (!res.ok)            return { config: {}, error: `GitHub API error (${res.status}).` };
    const data = await res.json();
    return { config: { token, owner: data.login as string } };
  }

  if (service === "vercel") {
    const res = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return { config: {}, error: "Invalid Vercel token." };
    if (!res.ok)            return { config: {}, error: `Vercel API error (${res.status}).` };
    const data = await res.json();

    // Try to also fetch the first team
    const teamsRes = await fetch("https://api.vercel.com/v2/teams?limit=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    let teamId = "";
    if (teamsRes.ok) {
      const teamsData = await teamsRes.json();
      teamId = teamsData.teams?.[0]?.id ?? "";
    }

    return { config: { token, username: data.user?.username ?? "", teamId } };
  }

  if (service === "sentry") {
    // Validate token by fetching the user endpoint
    const res = await fetch("https://sentry.io/api/0/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return { config: {}, error: "Invalid Sentry token — make sure it has event:read, organization:read, project:read scopes." };
    if (!res.ok)            return { config: {}, error: `Sentry API error (${res.status}).` };

    // Auto-fetch first org
    const orgsRes = await fetch("https://sentry.io/api/0/organizations/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    let org = "";
    if (orgsRes.ok) {
      const orgs = await orgsRes.json();
      org = orgs[0]?.slug ?? "";
    }

    return { config: { token, org } };
  }

  // Unknown service — just store the token
  return { config: { token } };
}

// ── Actions ───────────────────────────────────────────────────────────────────

export async function connectIntegration(
  formData: FormData
): Promise<{ error?: string }> {
  try {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string })?.id;
    if (!userId) return { error: "Not authenticated." };

    const projectId = formData.get("projectId") as string;
    const service   = formData.get("service")   as string;

    if (!projectId || !service) return { error: "Missing required fields." };

    // Verify project ownership
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);
    if (!project) return { error: "Project not found." };

    // ── Plan limit check ─────────────────────────────────────────────────────
    const [user] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1);
    const plan = user?.plan ?? "free";
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

    // Count integrations across all of the user's projects
    const userProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.userId, userId));
    const userProjectIds = userProjects.map((p) => p.id);

    if (userProjectIds.length > 0) {
      const allIntegrations = await db
        .select({ id: projectIntegrations.id })
        .from(projectIntegrations)
        .where(
          // Check if this is a new integration (not an update to existing)
          and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.service, service))
        )
        .limit(1);

      // Only enforce limit if this is a new integration, not an update
      if (allIntegrations.length === 0) {
        let totalIntegrations = 0;
        for (const pid of userProjectIds) {
          const [result] = await db
            .select({ count: count() })
            .from(projectIntegrations)
            .where(eq(projectIntegrations.projectId, pid));
          totalIntegrations += result.count;
        }

        if (totalIntegrations >= limits.maxIntegrations) {
          return {
            error: `Your ${plan} plan allows ${limits.maxIntegrations} integrations. Upgrade to ${plan === "free" ? "Pro" : "Team"} for more.`,
          };
        }
      }
    }

    let config: Record<string, unknown>;

    if (service === "uptime") {
      const endpointUrl = formData.get("endpoint_url") as string;
      if (!endpointUrl) return { error: "Endpoint URL is required." };

      // Validate URL — block SSRF (private IPs, non-http protocols)
      const urlCheck = validatePublicUrl(endpointUrl);
      if (!urlCheck.valid) return { error: urlCheck.error! };

      const endpointName = (formData.get("endpoint_name") as string) || new URL(endpointUrl).hostname;
      const expectedStatus = Number(formData.get("expected_status")) || 200;
      const timeoutMs = Math.max(1000, Math.min(60000, Number(formData.get("timeout_ms")) || 10000));

      config = {
        endpoints: [{
          url: endpointUrl,
          name: endpointName,
          expectedStatus,
          timeoutMs,
        }],
        alertConfig: {
          downtime: { enabled: true },
          slow_response: { enabled: true, thresholdMs: 5000 },
        },
      };
    } else if (service === "postgres") {
      const connectionString = formData.get("connection_string") as string;
      if (!connectionString) return { error: "Connection string is required." };

      const dbName = (formData.get("db_name") as string) || "PostgreSQL";

      config = {
        connectionString,
        name: dbName,
        alertConfig: {
          connection_failed: { enabled: true },
          high_connections: { enabled: true, thresholdPercent: 80 },
          long_queries: { enabled: true, thresholdSec: 30 },
        },
      };
    } else if (service === "npm") {
      const packageJsonUrl = formData.get("package_json_url") as string;
      const cargoTomlUrl = formData.get("cargo_toml_url") as string;
      const token = formData.get("token") as string;

      if (!packageJsonUrl && !cargoTomlUrl) {
        return { error: "Provide at least one file URL (package.json or Cargo.toml)." };
      }

      config = {
        ...(packageJsonUrl && { packageJsonUrl }),
        ...(cargoTomlUrl && { cargoTomlUrl }),
        ...(token && { token }),
        alertConfig: {
          critical_cves: { enabled: true },
          high_cves: { enabled: true },
        },
      };
    } else {
      const token = formData.get("token") as string;
      if (!token) return { error: "Token is required." };

      const { config: resolvedConfig, error } = await resolveConfig(service, token);
      if (error) return { error };
      config = resolvedConfig;
    }

    // Upsert
    const [existing] = await db
      .select()
      .from(projectIntegrations)
      .where(and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.service, service)))
      .limit(1);

    const rawWebhookSecret = generateWebhookSecret();
    const encryptedWebhookSecret = encrypt(rawWebhookSecret);

    if (existing) {
      let mergedConfig = config;

      // For uptime, merge new endpoints into existing list
      if (service === "uptime") {
        const existingCfg = decryptConfig(existing.configEncrypted);
        const existingEndpoints = (existingCfg.endpoints ?? []) as { url: string }[];
        const newEndpoints = (config.endpoints ?? []) as { url: string }[];
        const allEndpoints = [...existingEndpoints];
        for (const ep of newEndpoints) {
          if (!allEndpoints.some((e) => e.url === ep.url)) allEndpoints.push(ep);
        }
        mergedConfig = { ...existingCfg, ...config, endpoints: allEndpoints };
      }

      await db
        .update(projectIntegrations)
        .set({
          configEncrypted: encryptConfig(mergedConfig),
          isActive: true,
          errorCount: 0,
          webhookSecret: existing.webhookSecret ?? encryptedWebhookSecret,
        })
        .where(eq(projectIntegrations.id, existing.id));
    } else {
      await db.insert(projectIntegrations).values({
        projectId,
        service,
        configEncrypted: encryptConfig(config),
        isActive: true,
        webhookSecret: encryptedWebhookSecret,
      });
    }

    logAudit({ userId, action: "integration.connect", resource: "integration", metadata: { service } });
    revalidatePath("/integrations");
    revalidatePath("/dashboard");
    return {};
  } catch {
    return { error: "Failed to save. Please try again." };
  }
}

export async function saveAlertConfig(
  integrationId: string,
  alertConfig: Record<string, Record<string, unknown>>
): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  // Verify ownership via project chain
  const [integ] = await db
    .select({ id: projectIntegrations.id, projectId: projectIntegrations.projectId, configEncrypted: projectIntegrations.configEncrypted })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.id, integrationId))
    .limit(1);
  if (!integ) return;

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, integ.projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return;

  // Merge alertConfig into existing configEncrypted
  const existing = decryptConfig(integ.configEncrypted);
  const updated  = { ...existing, alertConfig };

  await db
    .update(projectIntegrations)
    .set({ configEncrypted: encryptConfig(updated) })
    .where(eq(projectIntegrations.id, integrationId));

  revalidatePath("/integrations");
}

export async function disconnectIntegration(integrationId: string): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  const [integ] = await db
    .select({ id: projectIntegrations.id, projectId: projectIntegrations.projectId })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.id, integrationId))
    .limit(1);
  if (!integ) return;

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, integ.projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return;

  await db.delete(projectIntegrations).where(eq(projectIntegrations.id, integrationId));
  logAudit({ userId, action: "integration.disconnect", resource: "integration", resourceId: integrationId });
  revalidatePath("/integrations");
  revalidatePath("/dashboard");
}
