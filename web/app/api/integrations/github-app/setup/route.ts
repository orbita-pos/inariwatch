// GitHub App post-install handler.
//
// GitHub redirects here after a user installs github.com/apps/inariwatch.
// Query params: installation_id, setup_action ("install" | "update").
//
// We:
//   1. Verify the user is logged into InariWatch (otherwise bounce through login).
//   2. Persist the installation under the user's primary org.
//   3. Mint an installation token, fetch the user's repos, open the
//      auto-PR ("Set up InariWatch") on each one in parallel.
//   4. Redirect to the dashboard with the first PR URL highlighted.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import {
  db,
  organizations,
  organizationMembers,
  users,
  githubAppInstallations,
  projects,
  projectIntegrations,
} from "@/lib/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { getInstallationToken, ghFetchApp, ghFetch } from "@/lib/github-app/octokit";
import { openSetupPRForInstallation } from "@/lib/github-app/open-setup-pr";
import { encrypt, encryptConfig } from "@/lib/crypto";
import { generateWebhookSecret } from "@/lib/webhooks/shared";

/**
 * Public base URL the app thinks it lives at. Inside the kamal-proxy'd
 * container `req.url` resolves to the bind address (`http://0.0.0.0:3000`)
 * not the public hostname, so any redirect built from `url.origin` would
 * 302 the user to localhost. Pin the canonical URL via env (NEXTAUTH_URL is
 * already set in sops; falls back to the production hostname).
 */
const APP_BASE = (
  process.env.NEXTAUTH_URL
    ?? process.env.APP_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? "https://app.inariwatch.com"
).replace(/\/$/, "");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const installationIdRaw = url.searchParams.get("installation_id");
  const setupAction       = url.searchParams.get("setup_action");
  // `state` round-trips the dashboard's projectId through GitHub so we can
  // attach this installation to the right project_integrations row. When
  // unset (e.g. user installs from github.com directly, not from our
  // dashboard) we still persist the org-level installation but skip the
  // per-project link.
  const stateProjectId    = url.searchParams.get("state");

  if (!installationIdRaw) {
    return NextResponse.redirect(new URL("/integrations?error=missing_installation", APP_BASE));
  }
  const installationId = Number(installationIdRaw);
  if (!Number.isFinite(installationId)) {
    return NextResponse.redirect(new URL("/integrations?error=bad_installation", APP_BASE));
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    const loginUrl = new URL("/login", APP_BASE);
    loginUrl.searchParams.set("from", url.pathname + url.search);
    return NextResponse.redirect(loginUrl);
  }

  // Resolve installation account (User vs Organization, login, id).
  // /app/installations/{id} is App-level → JWT (Bearer), not installation
  // token (`token` header). The installation token is minted separately
  // for the per-repo PR work below.
  let token: string;
  let accountInfo: { login: string; type: string; id: number };
  try {
    const res = await ghFetchApp(`/app/installations/${installationId}`);
    if (!res.ok) throw new Error(`installation: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { account: { login: string; type: string; id: number } };
    accountInfo = json.account;
    token = await getInstallationToken(installationId);
  } catch (err) {
    console.error("[github-app] setup failed:", err);
    return NextResponse.redirect(new URL("/integrations?error=github_app_init", APP_BASE));
  }

  // Resolve the install owner. Two modes after migration 0085:
  //   • Workspace mode — user already has at least one org; install lands
  //     under the first owned org and projects go under that workspace.
  //   • Personal mode — user has no org yet. We do NOT auto-create one;
  //     the install + projects belong directly to the user (organizationId
  //     stays NULL on both github_app_installations and projects rows).
  // Either way the user ends up on a populated dashboard. If they later
  // create a workspace, they can move projects into it from /settings.
  const orgRow = await firstOwnedOrgFor(session.user.email);
  let installerUserId: string;
  if (orgRow) {
    installerUserId = orgRow.userId;
  } else {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, session.user.email))
      .limit(1);
    if (!user) {
      return NextResponse.redirect(new URL("/integrations?error=user_not_found", APP_BASE));
    }
    installerUserId = user.id;
  }
  const installOrgId: string | null = orgRow?.id ?? null;

  // If the user has an org but their activeOrgId is still NULL (legacy
  // accounts created before the column existed), pin the workspace so
  // dashboard + /projects + /integrations queries land in workspace mode
  // and find the projects we're about to import. Personal-mode users
  // (no org) keep activeOrgId NULL — that's how the queries fall through
  // to "show me my personal-mode projects (organizationId IS NULL)".
  if (orgRow) {
    await db
      .update(users)
      .set({ activeOrgId: orgRow.id })
      .where(and(eq(users.id, orgRow.userId), sql`${users.activeOrgId} IS NULL`));
  }

  // Persist the installation row first so failures in the auto-PR step
  // don't lose the link. organizationId is null for personal-mode installs.
  await db
    .insert(githubAppInstallations)
    .values({
      organizationId:  installOrgId,
      installationId,
      accountLogin:    accountInfo.login,
      accountType:     accountInfo.type,
      accountId:       accountInfo.id,
      installedBy:     installerUserId,
    })
    .onConflictDoUpdate({
      target: githubAppInstallations.installationId,
      set: {
        accountLogin:  accountInfo.login,
        accountType:   accountInfo.type,
        uninstalledAt: null,
        updatedAt:     new Date(),
      },
    });

  // ── Bulk import (when no projectId in state) ────────────────────────────
  // "Import from GitHub" model — Vercel-style. The user comes from the
  // empty-state CTA on /dashboard or /integrations and we create one
  // project per repo they granted us access to, all backed by the same
  // installation. Existing projects (matched by `default_repo`) are
  // adopted in place rather than duplicated, so re-running the install
  // is idempotent.
  let importedProjectCount = 0;
  if (!stateProjectId) {
    try {
      const importedIds = await importProjectsFromInstallation({
        token,
        organizationId: installOrgId,
        installerUserId,
        installationId,
      });
      importedProjectCount = importedIds.length;
    } catch (err) {
      console.warn("[github-app] bulk import failed:", err instanceof Error ? err.message : err);
    }
  }

  // ── Per-project link (when the user came from /integrations) ────────────
  // The dashboard install button passes `state=<projectId>`. Verify the
  // project belongs to the same user/org (defense against tampered state),
  // then upsert a project_integrations row backed by this installation.
  if (stateProjectId) {
    try {
      const [project] = await db
        .select({ id: projects.id, organizationId: projects.organizationId, userId: projects.userId })
        .from(projects)
        .where(eq(projects.id, stateProjectId))
        .limit(1);

      const ownsProject =
        project &&
        (project.userId === installerUserId ||
          (installOrgId !== null && project.organizationId === installOrgId));

      if (ownsProject) {
        const [existing] = await db
          .select({ id: projectIntegrations.id, webhookSecret: projectIntegrations.webhookSecret })
          .from(projectIntegrations)
          .where(
            and(
              eq(projectIntegrations.projectId, project.id),
              eq(projectIntegrations.service, "github"),
            ),
          )
          .limit(1);

        const config = { owner: accountInfo.login };
        const webhookSecret = existing?.webhookSecret ?? encrypt(generateWebhookSecret());

        if (existing) {
          await db
            .update(projectIntegrations)
            .set({
              configEncrypted: encryptConfig(config),
              installationId,
              isActive: true,
              errorCount: 0,
            })
            .where(eq(projectIntegrations.id, existing.id));
        } else {
          await db.insert(projectIntegrations).values({
            projectId: project.id,
            service: "github",
            configEncrypted: encryptConfig(config),
            installationId,
            webhookSecret,
            isActive: true,
          });
        }
      }
    } catch (err) {
      console.warn("[github-app] project_integrations upsert failed:", err instanceof Error ? err.message : err);
    }
  }

  // Mint the DSN once — every PR we open in this run shares it. Workspace
  // installs key by org id; personal installs key by user id (prefixed so
  // it can't collide with an org uuid).
  const dsn = inariwatchDsnFor(installOrgId, installerUserId);

  // Open the auto-PR — best effort, parallelized across repos. Run on
  // every setup_action: `install` opens fresh, `update` is idempotent
  // (open-setup-pr handles existing branches/PRs via the 422 path) so
  // re-installs and re-clicks of the Configure page converge on the
  // same single PR.
  void setupAction; // intentionally unused — see comment above
  let firstPrUrl: string | null = null;
  try {
    const prs = await openSetupPRForInstallation(token, dsn);
    firstPrUrl = prs[0]?.url ?? null;
    if (prs[0]) {
      await db
        .update(githubAppInstallations)
        .set({
          setupPrUrl:    prs[0].url,
          setupPrOwner:  prs[0].owner,
          setupPrRepo:   prs[0].repo,
          setupPrNumber: prs[0].number,
          updatedAt:     new Date(),
        })
        .where(eq(githubAppInstallations.installationId, installationId));
    }
  } catch (err) {
    console.warn("[github-app] auto-PR generation failed:", err instanceof Error ? err.message : err);
  }

  // When the install was triggered from /integrations (state=<projectId>),
  // bounce the user straight back there so the new card row shows up
  // without an extra hop. Other paths (e.g. github.com → "Install" button)
  // still land on the dedicated success page with PR + DSN guidance.
  if (stateProjectId) {
    const back = new URL("/integrations", APP_BASE);
    back.searchParams.set("github", "installed");
    if (firstPrUrl) back.searchParams.set("pr", firstPrUrl);
    return NextResponse.redirect(back);
  }

  // Bulk-import path — land on /dashboard so the user sees their newly
  // created projects right away. The legacy success page is kept for
  // re-installs that didn't import anything new (count === 0).
  if (importedProjectCount > 0) {
    const back = new URL("/dashboard", APP_BASE);
    back.searchParams.set("github", "imported");
    back.searchParams.set("count", String(importedProjectCount));
    if (firstPrUrl) back.searchParams.set("pr", firstPrUrl);
    return NextResponse.redirect(back);
  }

  const redirect = new URL("/integrations/github-app/installed", APP_BASE);
  if (firstPrUrl) redirect.searchParams.set("pr", firstPrUrl);
  return NextResponse.redirect(redirect);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk import helper — creates one project per accessible repo. Returns
// the IDs of *newly created* projects (existing ones still get the
// installation_id linked but aren't counted). Idempotent.
// ─────────────────────────────────────────────────────────────────────────────

interface ImportArgs {
  token:           string;
  /** NULL = personal mode (project goes under userId, organizationId IS NULL). */
  organizationId:  string | null;
  installerUserId: string;
  installationId:  number;
}

async function importProjectsFromInstallation(args: ImportArgs): Promise<string[]> {
  const { token, organizationId, installerUserId, installationId } = args;

  const repos = await listInstallationRepositories(token);
  if (repos.length === 0) return [];

  const newProjectIds: string[] = [];

  for (const repo of repos) {
    const fullName = `${repo.ownerLogin}/${repo.name}`;

    // 1. Adopt existing project if one already maps to this repo. Workspace
    //    mode matches by organizationId; personal mode matches the same
    //    user's personal projects (organizationId IS NULL AND userId = me).
    const [existingProject] = await db
      .select({ id: projects.id, userId: projects.userId, organizationId: projects.organizationId })
      .from(projects)
      .where(
        and(
          organizationId === null
            ? and(sql`${projects.organizationId} IS NULL`, eq(projects.userId, installerUserId))
            : eq(projects.organizationId, organizationId),
          eq(projects.defaultRepo, fullName),
        ),
      )
      .limit(1);

    let projectId: string;
    if (existingProject) {
      projectId = existingProject.id;
    } else {
      // 2. Otherwise create a fresh one. Slug is unique-globally on the
      //    `slug` column, so we prefix with org id (workspace mode) or
      //    user id (personal mode) to keep collisions out.
      const slugBase = repo.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      const ownerKey = (organizationId ?? installerUserId).slice(0, 8);
      const slug = `${slugBase}-${ownerKey}`;
      try {
        const inserted = await db
          .insert(projects)
          .values({
            userId:         installerUserId,
            organizationId,
            name:           repo.name,
            slug,
            description:    `Imported from ${fullName} via GitHub App`,
            defaultRepo:    fullName,
          })
          .returning({ id: projects.id });
        projectId = inserted[0].id;
        newProjectIds.push(projectId);
      } catch (err) {
        // Slug collision (race or pre-existing) — fall back to a
        // lookup-by-defaultRepo and skip if still missing.
        const [retry] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              organizationId === null
                ? and(sql`${projects.organizationId} IS NULL`, eq(projects.userId, installerUserId))
                : eq(projects.organizationId, organizationId),
              eq(projects.defaultRepo, fullName),
            ),
          )
          .limit(1);
        if (!retry) {
          console.warn(`[github-app] could not create project for ${fullName}:`, err instanceof Error ? err.message : err);
          continue;
        }
        projectId = retry.id;
      }
    }

    // 3. Upsert the github project_integrations row backed by this install.
    const [existingIntegration] = await db
      .select({ id: projectIntegrations.id, webhookSecret: projectIntegrations.webhookSecret })
      .from(projectIntegrations)
      .where(
        and(
          eq(projectIntegrations.projectId, projectId),
          eq(projectIntegrations.service, "github"),
        ),
      )
      .limit(1);

    const config = { owner: repo.ownerLogin };
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
  }

  return newProjectIds;
}

async function listInstallationRepositories(
  token: string,
): Promise<Array<{ name: string; ownerLogin: string }>> {
  const out: Array<{ name: string; ownerLogin: string }> = [];
  let page = 1;
  for (;;) {
    const res = await ghFetch(token, `/installation/repositories?per_page=100&page=${page}`);
    if (!res.ok) break;
    const json = (await res.json()) as {
      total_count: number;
      repositories: Array<{ name: string; owner: { login: string } }>;
    };
    for (const r of json.repositories ?? []) {
      out.push({ name: r.name, ownerLogin: r.owner.login });
    }
    if ((json.repositories?.length ?? 0) < 100) break;
    page += 1;
    if (page > 10) break; // safety: 1000 repos max
  }
  return out;
}

/**
 * Build the Capture DSN. Format mirrors what the SDK expects:
 *   https://app.inariwatch.com/capture/<key>
 * Workspace installs use the org id as the key; personal installs use
 * the user id with a `u-` prefix so the keyspace can't collide with
 * an org uuid (orgs and users live in separate UUID spaces but the
 * `/capture/:key` route attributes by lookup, so the prefix is a safety
 * belt against future schema reuse).
 */
function inariwatchDsnFor(orgId: string | null, userId: string): string {
  const base = process.env.APP_URL ?? "https://app.inariwatch.com";
  const key = orgId ?? `u-${userId}`;
  return `${base.replace(/\/$/, "")}/capture/${key}`;
}

async function firstOwnedOrgFor(
  email: string,
): Promise<{ id: string; userId: string } | null> {
  const rows = await db
    .select({
      userId: users.id,
      orgId:  organizations.id,
    })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .innerJoin(organizations,        eq(organizations.id,         organizationMembers.organizationId))
    .where(eq(users.email, email))
    .orderBy(desc(sql`${organizations.ownerId} = ${users.id}`), asc(organizations.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.orgId, userId: row.userId };
}

