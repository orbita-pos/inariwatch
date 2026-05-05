/**
 * Auto-link GitHub App installation on user sign-in.
 *
 * When a user signs in with the GitHub App's user-OAuth (set up in
 * lib/auth.ts via GITHUB_APP_CLIENT_ID), the access token they get
 * back can list installations of OUR App that they have access to:
 *
 *   GET /user/installations  → only returns app_id matches when the
 *   token was minted via the App's OAuth (it's app-scoped, unlike a
 *   stand-alone OAuth App's token).
 *
 * We call this from NextAuth's jwt callback on first sign-in. If the
 * user has at least one installation of our App, we replay the same
 * persistence logic the /api/integrations/github-app/setup route uses
 * (insert githubAppInstallations row, bulk-import projects). Result:
 * after "Continue with GitHub", they land on /dashboard with their
 * repos already imported — no separate Install step.
 *
 * Soft-fail by design: if the access token isn't App-scoped (we're
 * still on the legacy OAuth App credentials) or the API rejects, we
 * just skip and the user gets the existing /onboarding redirect.
 */

import { db, githubAppInstallations, projects, projectIntegrations, users } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { encrypt, encryptConfig } from "@/lib/crypto";
import { generateWebhookSecret } from "@/lib/webhooks/shared";

interface UserInstallationsResponse {
  total_count:   number;
  installations: Array<{
    id:          number;
    app_id:      number;
    account:     { login: string; type: string; id: number };
    repository_selection: "all" | "selected";
  }>;
}

export async function linkGitHubInstallationsForUser(args: {
  userId:      string;
  accessToken: string;
  /** Org id when user has a workspace; null = personal mode. */
  organizationId: string | null;
}): Promise<number> {
  const appIdRaw = process.env.GITHUB_APP_ID;
  if (!appIdRaw) return 0;
  const appId = Number(appIdRaw);
  if (!Number.isFinite(appId)) return 0;

  let res: Response;
  try {
    res = await fetch("https://api.github.com/user/installations?per_page=100", {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        Accept:        "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    return 0;
  }
  if (!res.ok) return 0;

  const json = (await res.json().catch(() => null)) as UserInstallationsResponse | null;
  if (!json?.installations) return 0;

  const ours = json.installations.filter((i) => i.app_id === appId);
  if (ours.length === 0) return 0;

  let importedCount = 0;
  for (const install of ours) {
    // Persist the installation row (idempotent on conflict).
    await db
      .insert(githubAppInstallations)
      .values({
        organizationId: args.organizationId,
        installationId: install.id,
        accountLogin:   install.account.login,
        accountType:    install.account.type,
        accountId:      install.account.id,
        installedBy:    args.userId,
      })
      .onConflictDoUpdate({
        target: githubAppInstallations.installationId,
        set: {
          accountLogin:  install.account.login,
          accountType:   install.account.type,
          uninstalledAt: null,
          updatedAt:     new Date(),
        },
      });

    // Bulk-import projects for this install. Reuses the same repo
    // listing endpoint the /api/integrations/github-app/setup route
    // uses, so project rows look identical regardless of which path
    // the user took to get here.
    try {
      const installToken = await mintInstallationToken(install.id);
      if (!installToken) continue;
      const repos = await listInstallationRepositories(installToken);
      for (const repo of repos) {
        const created = await upsertProjectForRepo({
          owner:           repo.ownerLogin,
          name:            repo.name,
          installerUserId: args.userId,
          organizationId:  args.organizationId,
          installationId:  install.id,
        });
        if (created) importedCount += 1;
      }
    } catch {
      // Best-effort: skip this install's import on failure; the install
      // row is already persisted so /import still works for the user.
    }
  }

  // Pin activeOrgId for legacy accounts that still have it null. Skipped
  // for personal-mode users (organizationId === null is correct for them).
  if (args.organizationId) {
    await db
      .update(users)
      .set({ activeOrgId: args.organizationId })
      .where(and(eq(users.id, args.userId), sql`${users.activeOrgId} IS NULL`));
  }

  return importedCount;
}

// ──────────────────────────────────────────────────────────────────────────
// Internals — small wrappers around the App-JWT endpoints. Mirrors the
// helpers in /api/integrations/github-app/setup/route.ts; we don't reuse
// directly to keep this module callable from NextAuth's jwt callback
// without dragging the full setup-route surface into auth.ts.
// ──────────────────────────────────────────────────────────────────────────

async function mintInstallationToken(installationId: number): Promise<string | null> {
  try {
    const { getInstallationToken } = await import("@/lib/github-app/octokit");
    return await getInstallationToken(installationId);
  } catch {
    return null;
  }
}

async function listInstallationRepositories(
  installationToken: string,
): Promise<Array<{ name: string; ownerLogin: string }>> {
  const out: Array<{ name: string; ownerLogin: string }> = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `token ${installationToken}`,
          Accept:        "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) break;
    const json = (await res.json().catch(() => null)) as {
      repositories?: Array<{ name: string; owner: { login: string } }>;
    } | null;
    const repos = json?.repositories ?? [];
    for (const r of repos) out.push({ name: r.name, ownerLogin: r.owner.login });
    if (repos.length < 100) break;
    page += 1;
    if (page > 10) break; // safety
  }
  return out;
}

async function upsertProjectForRepo(args: {
  owner:           string;
  name:            string;
  installerUserId: string;
  organizationId:  string | null;
  installationId:  number;
}): Promise<boolean> {
  const fullName = `${args.owner}/${args.name}`;

  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        args.organizationId === null
          ? and(sql`${projects.organizationId} IS NULL`, eq(projects.userId, args.installerUserId))
          : eq(projects.organizationId, args.organizationId),
        eq(projects.defaultRepo, fullName),
      ),
    )
    .limit(1);

  let projectId: string;
  let created = false;
  if (existing) {
    projectId = existing.id;
  } else {
    const slugBase = args.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const ownerKey = (args.organizationId ?? args.installerUserId).slice(0, 8);
    const slug = `${slugBase}-${ownerKey}`;
    try {
      const inserted = await db
        .insert(projects)
        .values({
          userId:         args.installerUserId,
          organizationId: args.organizationId,
          name:           args.name,
          slug,
          description:    `Imported from ${fullName} via GitHub`,
          defaultRepo:    fullName,
        })
        .returning({ id: projects.id });
      projectId = inserted[0].id;
      created = true;
    } catch {
      // Slug collision — re-lookup, skip if still missing.
      const [retry] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            args.organizationId === null
              ? and(sql`${projects.organizationId} IS NULL`, eq(projects.userId, args.installerUserId))
              : eq(projects.organizationId, args.organizationId),
            eq(projects.defaultRepo, fullName),
          ),
        )
        .limit(1);
      if (!retry) return false;
      projectId = retry.id;
    }
  }

  // Upsert project_integrations row backed by this install.
  const [existingIntegration] = await db
    .select({ id: projectIntegrations.id })
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "github"),
      ),
    )
    .limit(1);

  const config = { owner: args.owner };
  if (existingIntegration) {
    await db
      .update(projectIntegrations)
      .set({
        configEncrypted: encryptConfig(config),
        installationId:  args.installationId,
        isActive:        true,
        errorCount:      0,
      })
      .where(eq(projectIntegrations.id, existingIntegration.id));
  } else {
    await db.insert(projectIntegrations).values({
      projectId,
      service:         "github",
      configEncrypted: encryptConfig(config),
      installationId:  args.installationId,
      webhookSecret:   encrypt(generateWebhookSecret()),
      isActive:        true,
    });
  }

  return created;
}
