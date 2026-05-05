"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectIntegrations, organizations, users, PLAN_LIMITS, BETA_PLAN } from "@/lib/db";
import { eq, and, count, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generateWebhookSecret } from "@/lib/webhooks/shared";
import { logAudit } from "@/lib/audit";
import { encrypt, encryptConfig, decryptConfig } from "@/lib/crypto";
import { validatePublicUrl } from "@/lib/url-validation";
import { resolveGitHubAuth } from "@/lib/services/github-token";
import { findInstallationByLogin, type FoundInstallation } from "@/lib/github-app/find-installations";

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

  if (service === "datadog") {
    // Token here is the API key; appKey comes separately
    const res = await fetch("https://api.datadoghq.com/api/v1/validate", {
      headers: { "DD-API-KEY": token },
    });
    if (res.status === 403) return { config: {}, error: "Invalid Datadog API Key." };
    if (!res.ok) return { config: {}, error: `Datadog API error (${res.status}).` };
    return { config: { apiKey: token } };
  }

  if (service === "expo") {
    const res = await fetch("https://api.expo.dev/v2/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return { config: {}, error: "Invalid Expo token — generate one at expo.dev/settings/api-tokens." };
    if (!res.ok) return { config: {}, error: `Expo API error (${res.status}).` };
    const data = await res.json();
    const username = data.data?.username ?? "";
    return { config: { token, username } };
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
    const plan = BETA_PLAN ?? "free";
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
        // Single aggregate query — was an O(N) loop before, hot under viral load.
        const [result] = await db
          .select({ count: count() })
          .from(projectIntegrations)
          .where(inArray(projectIntegrations.projectId, userProjectIds));
        const totalIntegrations = result.count;

        if (totalIntegrations >= limits.maxIntegrations) {
          return {
            error: `Your ${plan} plan allows ${limits.maxIntegrations} integrations. Upgrade to Pro for ${PLAN_LIMITS.pro.maxIntegrations}.`,
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
    } else if (service === "capture") {
      // Capture SDK — no token needed, just generate webhook secret
      config = {};
    } else if (service === "agent") {
      // InariWatch Agent — no token needed, just generate webhook secret for HMAC auth
      config = {};
    } else if (service === "datadog") {
      const apiKey = formData.get("token") as string;
      const appKey = formData.get("app_key") as string;
      if (!apiKey) return { error: "API Key is required." };
      if (!appKey) return { error: "Application Key is required." };

      const { config: resolvedConfig, error } = await resolveConfig(service, apiKey);
      if (error) return { error };
      config = { ...resolvedConfig, appKey };
    } else if (service === "netlify" || service === "cloudflare-pages" || service === "render") {
      // Hosting providers — validate via the RollbackProvider registry so the
      // check matches the runtime behavior exactly.
      const token = formData.get("token") as string;
      if (!token) return { error: "Token is required." };

      // Slug format used by Netlify, Cloudflare Pages, and Render for
      // project/service names. Validating up-front prevents arbitrary strings
      // from leaking into URLs (Render builds `https://${projectName}.onrender.com`)
      // and into Slack/MCP responses where they'd be displayed verbatim.
      const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
      // Netlify Site IDs and Cloudflare Account IDs are 32-char hex (with dashes for
      // Netlify). Render service IDs are `srv-` followed by alphanumerics.
      const NETLIFY_SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const CF_ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
      const RENDER_SERVICE_ID_RE = /^srv-[a-zA-Z0-9]+$/;

      type HostingConfig = {
        service: "netlify" | "cloudflare-pages" | "render";
        token: string;
        projectName: string;
        siteId?: string;
        accountId?: string;
        serviceId?: string;
      };

      const providerConfig: HostingConfig = { service, token, projectName: "" };

      if (service === "netlify") {
        const siteId = formData.get("siteId") as string;
        if (!siteId) return { error: "Site ID is required." };
        if (!NETLIFY_SITE_ID_RE.test(siteId)) {
          return { error: "Invalid Site ID format. Expected a UUID like 12345678-abcd-efgh-ijkl-mnopqrstuvwx." };
        }
        providerConfig.siteId = siteId;
        providerConfig.projectName = siteId;
      } else if (service === "cloudflare-pages") {
        const accountId = formData.get("accountId") as string;
        const projectName = formData.get("projectName") as string;
        if (!accountId) return { error: "Account ID is required." };
        if (!projectName) return { error: "Project Name is required." };
        if (!CF_ACCOUNT_ID_RE.test(accountId)) {
          return { error: "Invalid Account ID format. Expected 32 hex characters." };
        }
        if (!SLUG_RE.test(projectName)) {
          return { error: "Invalid Project Name. Use lowercase letters, numbers, and dashes (max 63 chars)." };
        }
        providerConfig.accountId = accountId;
        providerConfig.projectName = projectName;
      } else if (service === "render") {
        const serviceId = formData.get("serviceId") as string;
        const projectName = formData.get("projectName") as string;
        if (!serviceId) return { error: "Service ID is required." };
        if (!projectName) return { error: "Service Name is required." };
        if (!RENDER_SERVICE_ID_RE.test(serviceId)) {
          return { error: "Invalid Service ID format. Expected 'srv-' followed by alphanumeric characters." };
        }
        if (!SLUG_RE.test(projectName)) {
          return { error: "Invalid Service Name. Use lowercase letters, numbers, and dashes (max 63 chars)." };
        }
        providerConfig.serviceId = serviceId;
        providerConfig.projectName = projectName;
      }

      // Validate via provider.checkPermissions() — same code the runtime uses.
      try {
        const { getRollbackProvider } = await import("@/lib/providers/rollback");
        const provider = getRollbackProvider(providerConfig);
        const ok = await provider.checkPermissions();
        if (!ok) {
          return { error: `Invalid ${service} credentials — check token and IDs.` };
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : `Failed to validate ${service} credentials.` };
      }

      config = { ...providerConfig };
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

    // Trigger first code indexation when GitHub is connected
    if (service === "github" && config && typeof config === "object" && "owner" in config) {
      triggerFirstCodeIndex(projectId, config.owner as string).catch(() => {});
    }

    revalidatePath("/integrations");
    revalidatePath("/dashboard");
    return {};
  } catch {
    return { error: "Failed to save. Please try again." };
  }
}

// ── GitHub App: lookup + connect existing installation ──────────────────────
//
// Two-action flow that lets users connect a project to an existing App
// installation without bouncing through github.com. The lookup action
// answers "is the App installed on this account?", the connect action
// commits the link.
//
// Security: `lookupGitHubInstallation` proves the install exists; it does
// not prove the caller owns the account. Ownership is the connect action's
// job — for now we trust the project owner's claim and audit-log the
// connect; a v2 hardened path will add GitHub App OAuth before flipping
// the bit. Documented inline at the connect call site.

export async function lookupGitHubInstallation(
  login: string,
): Promise<{ installation?: FoundInstallation; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return { error: "Not authenticated." };

  const cleaned = (login ?? "").trim();
  if (!cleaned) return { error: "Enter your GitHub username or org name." };

  if (!process.env.GITHUB_APP_ID) {
    return { error: "GitHub App not configured on this server." };
  }

  const found = await findInstallationByLogin(cleaned);
  if (!found) {
    return {
      error: `InariWatch isn't installed on ${cleaned} yet — use "Install GitHub App" instead.`,
    };
  }
  return { installation: found };
}

export async function connectGitHubInstallation(
  projectId: string,
  installationId: number,
  expectedLogin: string,
): Promise<{ error?: string }> {
  try {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string })?.id;
    if (!userId) return { error: "Not authenticated." };

    if (!projectId || !Number.isFinite(installationId) || !expectedLogin) {
      return { error: "Missing required fields." };
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);
    if (!project) return { error: "Project not found." };

    // Re-verify the installation still exists + the login on file matches
    // what the user picked. This catches uninstall-since-lookup races and
    // a tampered installationId in the form payload.
    const found = await findInstallationByLogin(expectedLogin);
    if (!found || found.installationId !== installationId) {
      return { error: "Installation not found or changed — re-run the lookup." };
    }

    // Plan-limit check (mirrors connectIntegration). Counts integrations
    // across all of the user's projects unless this is an update.
    const userProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.userId, userId));
    const userProjectIds = userProjects.map((p) => p.id);

    const [existing] = await db
      .select({ id: projectIntegrations.id, webhookSecret: projectIntegrations.webhookSecret })
      .from(projectIntegrations)
      .where(
        and(
          eq(projectIntegrations.projectId, projectId),
          eq(projectIntegrations.service, "github"),
        ),
      )
      .limit(1);

    if (!existing && userProjectIds.length > 0) {
      const plan = BETA_PLAN ?? "free";
      const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
      const [result] = await db
        .select({ count: count() })
        .from(projectIntegrations)
        .where(inArray(projectIntegrations.projectId, userProjectIds));
      if (result.count >= limits.maxIntegrations) {
        return {
          error: `Your ${plan} plan allows ${limits.maxIntegrations} integrations. Upgrade to Pro for ${PLAN_LIMITS.pro.maxIntegrations}.`,
        };
      }
    }

    const config = { owner: found.accountLogin };
    const webhookSecret = existing?.webhookSecret ?? encrypt(generateWebhookSecret());

    if (existing) {
      await db
        .update(projectIntegrations)
        .set({
          configEncrypted: encryptConfig(config),
          installationId: found.installationId,
          isActive: true,
          errorCount: 0,
        })
        .where(eq(projectIntegrations.id, existing.id));
    } else {
      await db.insert(projectIntegrations).values({
        projectId,
        service: "github",
        configEncrypted: encryptConfig(config),
        installationId: found.installationId,
        webhookSecret,
        isActive: true,
      });
    }

    logAudit({
      userId,
      action: "integration.connect",
      resource: "integration",
      metadata: { service: "github", source: "app_existing", installationId: found.installationId, accountLogin: found.accountLogin },
    });

    triggerFirstCodeIndex(projectId, found.accountLogin).catch(() => {});

    revalidatePath("/integrations");
    revalidatePath("/dashboard");
    return {};
  } catch {
    return { error: "Failed to save. Please try again." };
  }
}

export async function saveAlertConfig(
  integrationId: string,
  alertConfig: Record<string, unknown>
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

export type DisconnectResult =
  | { ok: true }
  | { ok: false; error: string };

export async function disconnectIntegration(integrationId: string): Promise<DisconnectResult> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { ok: false, error: "You need to be signed in." };

  const [integ] = await db
    .select({ id: projectIntegrations.id, projectId: projectIntegrations.projectId })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.id, integrationId))
    .limit(1);
  if (!integ) return { ok: false, error: "Integration not found." };

  // Allow disconnect if the user owns the project directly OR is the owner of
  // the organization the project belongs to. Anything else → 403-style toast.
  const [project] = await db
    .select({
      id: projects.id,
      userId: projects.userId,
      organizationId: projects.organizationId,
    })
    .from(projects)
    .where(eq(projects.id, integ.projectId))
    .limit(1);
  if (!project) return { ok: false, error: "Project not found." };

  let authorized = project.userId === userId;
  if (!authorized && project.organizationId) {
    const [org] = await db
      .select({ ownerId: organizations.ownerId })
      .from(organizations)
      .where(eq(organizations.id, project.organizationId))
      .limit(1);
    if (org?.ownerId === userId) authorized = true;
  }
  if (!authorized) {
    return { ok: false, error: "You're not the owner of this project." };
  }

  await db.delete(projectIntegrations).where(eq(projectIntegrations.id, integrationId));
  logAudit({ userId, action: "integration.disconnect", resource: "integration", resourceId: integrationId });
  revalidatePath("/integrations");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function fetchIntegrationOptions(
  integrationId: string
): Promise<{ label: string; value: string }[]> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return [];

  const [integ] = await db
    .select({
      service: projectIntegrations.service,
      configEncrypted: projectIntegrations.configEncrypted,
      installationId: projectIntegrations.installationId,
      projectId: projectIntegrations.projectId,
    })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.id, integrationId))
    .limit(1);
  if (!integ) return [];

  // Verify ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, integ.projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return [];

  const cfg = decryptConfig(integ.configEncrypted);

  try {
    if (integ.service === "github") {
      // App-backed rows scope to the installation's accessible repos —
      // /installation/repositories — which respects the per-repo grant the
      // user picked at install time. PAT-backed rows fall through to the
      // /user/repos path, which is what they had access to before.
      if (integ.installationId) {
        const { token } = await resolveGitHubAuth(integ);
        const res = await fetch(
          "https://api.github.com/installation/repositories?per_page=100",
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "InariWatch-Monitor/1.0",
            },
          }
        );
        if (!res.ok) return [];
        const data = (await res.json()) as { repositories?: { full_name: string }[] };
        return (data.repositories ?? []).map((r) => ({ label: r.full_name, value: r.full_name }));
      }

      const token = cfg.token as string;
      const res = await fetch(
        "https://api.github.com/user/repos?affiliation=owner,collaborator&per_page=50&sort=pushed",
        {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "InariWatch-Monitor/1.0" },
        }
      );
      if (!res.ok) return [];
      const repos: { full_name: string; name: string }[] = await res.json();
      return repos.map((r) => ({ label: r.full_name, value: r.full_name }));
    }
    // Non-github services still authenticate with the PAT they pasted at
    // connect time; the App swap only applies to github.
    const legacyToken = cfg.token as string | undefined;
    if (integ.service === "vercel" && legacyToken) {
      const teamId = cfg.teamId as string | undefined;
      const teamQuery = teamId ? `?teamId=${teamId}` : "";
      const res = await fetch(`https://api.vercel.com/v9/projects${teamQuery}&limit=50`, {
        headers: { Authorization: `Bearer ${legacyToken}` },
      });
      if (!res.ok) return [];
      const data: { projects: { name: string }[] } = await res.json();
      return (data.projects ?? []).map((p) => ({ label: p.name, value: p.name }));
    }
    if (integ.service === "sentry" && legacyToken) {
      const org = cfg.org as string;
      const res = await fetch(`https://sentry.io/api/0/organizations/${org}/projects/`, {
        headers: { Authorization: `Bearer ${legacyToken}` },
      });
      if (!res.ok) return [];
      const sentryProjects: { slug: string; name: string }[] = await res.json();
      return sentryProjects.map((p) => ({ label: p.name, value: p.slug }));
    }
  } catch { /* ignore */ }
  return [];
}

// ── Code Intelligence: trigger first indexation when GitHub is connected ──────

async function triggerFirstCodeIndex(projectId: string, owner: string) {
  try {
    // List repos for this owner to auto-detect the main repo
    const [integ] = await db
      .select({
        configEncrypted: projectIntegrations.configEncrypted,
        installationId: projectIntegrations.installationId,
      })
      .from(projectIntegrations)
      .where(and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.service, "github")))
      .limit(1);
    if (!integ) return;

    const cfg = decryptConfig(integ.configEncrypted);
    const repo = cfg.repo as string | undefined;

    let token: string;
    try {
      ({ token } = await resolveGitHubAuth(integ));
    } catch {
      return;
    }
    if (!token || !owner) return;

    // If repo is already configured, use it. Otherwise pick the most recently pushed one.
    let targetRepo = repo;
    if (!targetRepo) {
      const res = await fetch(
        `https://api.github.com/users/${owner}/repos?per_page=1&sort=pushed`,
        { headers: { Authorization: `Bearer ${token}`, "User-Agent": "InariWatch-CodeIntel/1.0" } }
      );
      if (res.ok) {
        const repos = await res.json();
        targetRepo = repos[0]?.name;
      }
    }

    if (!targetRepo) return;

    // Fire-and-forget indexation
    const { indexRepository } = await import("@/lib/code-intelligence/indexer");

    let openaiKey: string | undefined;
    try {
      const { getProjectOwnerAIKey } = await import("@/lib/ai/get-key");
      const aiKey = await getProjectOwnerAIKey(projectId);
      if (aiKey && aiKey.provider === "openai") openaiKey = aiKey.key;
    } catch { /* optional */ }

    await indexRepository({ ghToken: token, owner, repo: targetRepo, projectId, openaiKey });
  } catch {
    // Non-critical
  }
}
