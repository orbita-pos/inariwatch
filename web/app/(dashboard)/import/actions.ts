"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  db,
  projects,
  projectIntegrations,
  githubAppInstallations,
  organizations,
} from "@/lib/db";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { encrypt, encryptConfig } from "@/lib/crypto";
import { generateWebhookSecret } from "@/lib/webhooks/shared";
import { getInstallationToken } from "@/lib/github-app/octokit";
import { transitionState, getProjectState } from "@/lib/projects/state";
import { emitWizardOpen } from "@/lib/relay/wizard-events";
import { getActiveOrgId } from "@/lib/workspace";

/**
 * Server action: import a single repo as a new project.
 *
 * The /import page lists repos accessible via the user's App
 * installation; each repo's "Add" button calls this. We re-verify
 * (a) the user owns the installation that covers the repo, then
 * (b) idempotently create a project + project_integrations row
 * pointing at this repo.
 */
/**
 * Inari Live V1 — Session 3 wizard delivery outcome. Returned alongside
 * the project slug so callers (web Add Project page, future /import
 * banner) can render the right CTA when delivery fails:
 *   * `delivered` — relay routed to the user's online sidecar
 *   * `sidecar_offline` — desktop not connected; show "Open Inari Live"
 *   * `relay_disabled` — RELAY_URL not configured (local dev / OSS env);
 *     project still in `needs_setup`, manual setup link surfaced
 *   * `not_emitted` — project already past wizard (live, archived);
 *     no-op, treat as success
 */
export type WizardDelivery =
  | "delivered"
  | "sidecar_offline"
  | "relay_disabled"
  | "not_emitted";

export async function addProjectFromRepo(
  installationId: number,
  owner: string,
  repo: string,
): Promise<{
  ok?: true;
  slug?: string;
  projectId?: string;
  wizardDelivery?: WizardDelivery;
  error?: string;
}> {
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

  // Honor the user's currently-active workspace. Importing into a
  // different workspace than the one the user is viewing was a quiet
  // pre-V1.5 behavior — the action used to take `install.organizationId`
  // straight, which silently flipped the user's `activeOrgId` to that
  // org. Users on Personal saw new projects vanish into a workspace
  // they didn't pick. We now require the install's scope to match the
  // active workspace, and bubble a clear error when it doesn't. Errors
  // surface the InariWatch workspace's display name (NOT the GitHub
  // login) so users recognize which row in the workspace switcher to
  // pick — `orbita-pos` could be a GitHub username AND a workspace
  // name AND a coincidence.
  const activeOrgId = await getActiveOrgId(userId);

  async function workspaceLabelFor(orgId: string): Promise<string> {
    const [row] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return row?.name ?? "another workspace";
  }

  if (activeOrgId === null) {
    // Personal workspace: only personal installs (org-less, by this user) qualify.
    if (install.organizationId !== null) {
      const wsLabel = await workspaceLabelFor(install.organizationId);
      return {
        error: `This GitHub install belongs to the "${wsLabel}" workspace. Switch to that workspace to import this repo, or install the GitHub App on your personal GitHub (${install.accountLogin}) account.`,
      };
    }
    if (install.installedBy !== userId) {
      return { error: "You don't own this installation." };
    }
  } else {
    // Org workspace: install must belong to this exact org.
    if (install.organizationId !== activeOrgId) {
      const where = install.organizationId
        ? `the "${await workspaceLabelFor(install.organizationId)}" workspace`
        : `your personal account (GitHub ${install.accountLogin})`;
      return {
        error: `This GitHub install belongs to ${where}. Switch workspace to import this repo.`,
      };
    }
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
  // `orgId` for the new project = the active workspace, NOT the install's
  // org. The strict matching above guarantees the install is appropriate
  // for this workspace.
  const orgId    = activeOrgId;

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
  let createdNow = false;
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
          // Inari Live V1 S3 — fresh imports start at `created`. The
          // `transitionState` call below (line ~210) flips to
          // `needs_setup` after the GitHub integration row is wired up.
          state: "created",
        })
        .returning({ id: projects.id });
      projectId = inserted[0].id;
      createdNow = true;
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

  // 5. (Removed in V1.5) The pre-V1.5 build silently flipped the user's
  //    `activeOrgId` to the install's org. That was the second half of
  //    the "vanishing project" bug — a Personal-mode user importing a
  //    repo owned by an org would land on the org dashboard with no
  //    indication. Active workspace is now controlled by the workspace
  //    switcher only.

  // Inari Live V1 — Session 3. For freshly created projects, advance
  // state to `needs_setup` and emit the wizard.open relay task so the
  // user's online Inari Live install pops the wizard. Idempotent for
  // already-existing projects (transition fails silently when state
  // is already past `created`).
  let wizardDelivery: WizardDelivery = "not_emitted";
  if (createdNow) {
    try {
      await transitionState({
        projectId,
        from: "created",
        to:   "needs_setup",
        userId,
        metadata: { source: "github_import", repoFullName: fullName },
      });
      // Workspace-level Vercel hint: if the user already wired Vercel
      // for any OTHER project in this workspace, assume this new one
      // is also Vercel-hosted. The desktop wizard's filesystem detect
      // (vercel.json / .vercel/project.json) misses repos that deploy
      // via GitHub→Vercel integration without local marker files —
      // which is the majority of Next.js apps. Without this hint the
      // user lands in the Tier 2/3 picker and Vercel isn't an option.
      const host = await detectVercelHostHint(userId, orgId);
      const outcome = await emitWizardOpen(userId, {
        projectId,
        projectSlug:  slug,
        repoFullName: fullName,
        framework:    null, // detected client-side by the desktop wizard
        host,
        createdAt:    new Date().toISOString(),
      });
      if (outcome.ok) {
        wizardDelivery = "delivered";
      } else if (outcome.reason === "config-missing") {
        wizardDelivery = "relay_disabled";
      } else if (outcome.reason === "sidecar-offline" || outcome.reason === "sidecar-disconnect") {
        wizardDelivery = "sidecar_offline";
      } else {
        wizardDelivery = "sidecar_offline"; // map all other transport failures to "open Inari Live" CTA
      }
    } catch {
      // Best-effort — wizard surfacing should never roll back a
      // successful project creation. The dashboard's own state-aware
      // banners cover the user-facing CTA path.
      wizardDelivery = "not_emitted";
    }
  } else {
    // Already-existing project — surface its current state so the
    // caller can decide whether to launch the wizard. Never re-emit.
    const cur = await getProjectState(projectId).catch(() => null);
    if (cur === "needs_setup" || cur === "setting_up" || cur === "prepared") {
      wizardDelivery = "sidecar_offline";
    }
  }

  revalidatePath("/dashboard");
  revalidatePath("/projects");
  revalidatePath("/import");
  return { ok: true, slug, projectId, wizardDelivery };
}

/**
 * Workspace-scoped Vercel hint for the wizard payload. Returns
 * `"vercel"` when ANY existing project in the user's active workspace
 * already has a Vercel integration row — indicating the user has
 * wired Vercel before and the new project is likely the same. Returns
 * `null` when there's no signal, so the desktop falls through to its
 * filesystem-based detection (vercel.json / .vercel/project.json).
 *
 * Best-effort and silent on failure — a hint miss just sends the user
 * through the host picker, which is the pre-fix behaviour.
 */
async function detectVercelHostHint(
  userId: string,
  orgId:  string | null,
): Promise<"vercel" | null> {
  try {
    const [hit] = await db
      .select({ id: projectIntegrations.id })
      .from(projectIntegrations)
      .innerJoin(projects, eq(projects.id, projectIntegrations.projectId))
      .where(
        and(
          eq(projectIntegrations.service, "vercel"),
          orgId === null
            ? and(isNull(projects.organizationId), eq(projects.userId, userId))
            : eq(projects.organizationId, orgId),
        ),
      )
      .limit(1);
    return hit ? "vercel" : null;
  } catch {
    return null;
  }
}
