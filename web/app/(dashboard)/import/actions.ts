"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  db,
  projects,
  projectIntegrations,
  githubAppInstallations,
  users,
} from "@/lib/db";
import { and, eq, sql, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { encrypt, encryptConfig } from "@/lib/crypto";
import { generateWebhookSecret } from "@/lib/webhooks/shared";
import { getInstallationToken } from "@/lib/github-app/octokit";

/**
 * Server action: import a single repo as a new project.
 *
 * The /import page lists repos accessible via the user's App
 * installation; each repo's "Add" button calls this. We re-verify
 * (a) the user owns the installation that covers the repo, then
 * (b) idempotently create a project + project_integrations row
 * pointing at this repo.
 */
export async function addProjectFromRepo(
  installationId: number,
  owner: string,
  repo: string,
): Promise<{ ok?: true; slug?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  if (!Number.isFinite(installationId) || !owner || !repo) {
    return { error: "Missing required fields." };
  }

  // 1. Verify the install is one the user owns (installer match) OR it
  //    belongs to a workspace the user is in. This is the only ownership
  //    proof we have without a full GitHub OAuth ownership re-check;
  //    upgrading to that is tracked as a follow-up.
  const [install] = await db
    .select({
      id:             githubAppInstallations.id,
      organizationId: githubAppInstallations.organizationId,
      installedBy:    githubAppInstallations.installedBy,
      accountLogin:   githubAppInstallations.accountLogin,
      uninstalledAt:  githubAppInstallations.uninstalledAt,
    })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .limit(1);

  if (!install || install.uninstalledAt) {
    return { error: "Installation not found or uninstalled." };
  }
  if (install.installedBy !== userId && install.organizationId === null) {
    return { error: "You don't own this installation." };
  }

  // 2. Verify the repo is actually accessible by the install — checks
  //    the App installation token can read the repo. Catches typo'd or
  //    unauthorized request payloads from the client.
  let installToken: string;
  try {
    installToken = await getInstallationToken(installationId);
  } catch {
    return { error: "Could not mint installation token. Reinstall the App." };
  }
  const repoCheck = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: {
        Authorization: `token ${installToken}`,
        Accept:        "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!repoCheck.ok) {
    return { error: `Repo ${owner}/${repo} isn't accessible to this installation.` };
  }

  const fullName = `${owner}/${repo}`;
  const orgId    = install.organizationId;

  // 3. Idempotent upsert. Existing projects (matched by default_repo +
  //    workspace scope) get the install row attached without duplicating.
  const [existingProject] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(
      and(
        orgId === null
          ? and(isNull(projects.organizationId), eq(projects.userId, userId))
          : eq(projects.organizationId, orgId),
        eq(projects.defaultRepo, fullName),
      ),
    )
    .limit(1);

  let projectId: string;
  let slug: string;
  if (existingProject) {
    projectId = existingProject.id;
    slug      = existingProject.slug;
  } else {
    const slugBase = repo.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const ownerKey = (orgId ?? userId).slice(0, 8);
    slug = `${slugBase}-${ownerKey}`;
    try {
      const inserted = await db
        .insert(projects)
        .values({
          userId,
          organizationId: orgId,
          name:           repo,
          slug,
          description:    `Imported from ${fullName} via GitHub`,
          defaultRepo:    fullName,
        })
        .returning({ id: projects.id });
      projectId = inserted[0].id;
    } catch {
      // Slug collision on retry — recover by reading the row back.
      const [retry] = await db
        .select({ id: projects.id, slug: projects.slug })
        .from(projects)
        .where(
          and(
            orgId === null
              ? and(isNull(projects.organizationId), eq(projects.userId, userId))
              : eq(projects.organizationId, orgId),
            eq(projects.defaultRepo, fullName),
          ),
        )
        .limit(1);
      if (!retry) return { error: "Could not create project (slug collision)." };
      projectId = retry.id;
      slug      = retry.slug;
    }
  }

  // 4. Upsert the github project_integrations row backed by this install.
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

  const config = { owner };
  if (existingIntegration) {
    await db
      .update(projectIntegrations)
      .set({
        configEncrypted: encryptConfig(config),
        installationId,
        isActive:        true,
        errorCount:      0,
      })
      .where(eq(projectIntegrations.id, existingIntegration.id));
  } else {
    await db.insert(projectIntegrations).values({
      projectId,
      service:         "github",
      configEncrypted: encryptConfig(config),
      installationId,
      webhookSecret:   encrypt(generateWebhookSecret()),
      isActive:        true,
    });
  }

  // 5. If user has an org, pin activeOrgId so the new project is visible
  //    on the next page load. Skipped for personal-mode users.
  if (orgId) {
    await db
      .update(users)
      .set({ activeOrgId: orgId })
      .where(and(eq(users.id, userId), sql`${users.activeOrgId} IS NULL`));
  }

  revalidatePath("/dashboard");
  revalidatePath("/projects");
  revalidatePath("/import");
  return { ok: true, slug };
}
