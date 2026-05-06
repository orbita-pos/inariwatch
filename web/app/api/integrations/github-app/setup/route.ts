// GitHub App post-install handler.
//
// GitHub redirects here after a user installs github.com/apps/inariwatch.
// Query params:
//   installation_id   — required; GitHub's id for the new install
//   setup_action      — "install" | "update"; informational
//   state             — optional projectId, set when the user came from
//                       the legacy /integrations "Connect" button. We use
//                       it to attach the install to that specific project
//                       AND open a setup PR (legacy auto-PR behavior).
//
// What we do:
//   1. Verify the user is logged in (otherwise bounce through /login).
//   2. Persist the installation row under the user (and their primary
//      org if they have one).
//   3. If `state=<projectId>` is present (legacy /integrations path):
//        • Upsert project_integrations on that project
//        • Open the setup PR (best-effort)
//        • Redirect back to /integrations
//      Otherwise (Vercel-style "Install from github.com" path):
//        • Redirect to /import?github=installed so the user picks which
//          repos become projects with one click each. No bulk import,
//          no auto-PR — those happen per-repo in /import's server action.

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

import { getInstallationToken, ghFetchApp } from "@/lib/github-app/octokit";
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
  // setup_action ("install" | "update") is informational — both paths
  // converge on the same idempotent upsert below.
  const stateProjectId    = url.searchParams.get("state");

  if (!installationIdRaw) {
    return NextResponse.redirect(new URL("/import?error=missing_installation", APP_BASE));
  }
  const installationId = Number(installationIdRaw);
  if (!Number.isFinite(installationId)) {
    return NextResponse.redirect(new URL("/import?error=bad_installation", APP_BASE));
  }

  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
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
    return NextResponse.redirect(new URL("/import?error=github_app_init", APP_BASE));
  }

  // Personal-first install ownership — matches the OAuth path in
  // lib/auth.ts (jwt callback always passes organizationId:null to
  // linkGitHubInstallationsForUser). The previous behavior auto-attached
  // the install to the user's first owned org, which then propagated to
  // every imported project via addProjectFromRepo (projects.organization_id
  // = install.organization_id). Result: a user with a stale legacy
  // workspace would see all their imports land there silently.
  //
  // We do NOT auto-pin activeOrgId here either — that flips the dashboard
  // into workspace mode for users who never asked for it. Workspace
  // selection is an explicit choice from /settings or the workspace
  // switcher; the install stays personal until the user moves it.
  //
  // Legacy state-based path below (`if (stateProjectId)`) still uses
  // `firstOwnedOrgFor` to validate project ownership when the project
  // already belongs to a workspace — that branch is unaffected.
  const installOrgId: string | null = null;

  // Persist the installation row first so failures further down don't
  // lose the link. organizationId is null for personal-mode installs.
  await db
    .insert(githubAppInstallations)
    .values({
      organizationId:  installOrgId,
      installationId,
      accountLogin:    accountInfo.login,
      accountType:     accountInfo.type,
      accountId:       accountInfo.id,
      installedBy:     userId,
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

  // ── Legacy state path (came from /integrations Connect button) ───────
  // Verify the project belongs to this user/org, attach the install to
  // its project_integrations row, open the setup PR, redirect back.
  if (stateProjectId) {
    let firstPrUrl: string | null = null;

    try {
      const [project] = await db
        .select({ id: projects.id, organizationId: projects.organizationId, userId: projects.userId })
        .from(projects)
        .where(eq(projects.id, stateProjectId))
        .limit(1);

      // Personal-owned projects: direct user match. Workspace-owned
      // projects: the user must own (or be a member of) the workspace
      // the project belongs to. We resolve workspace membership lazily
      // here because the install itself stays personal — the workspace
      // check is only needed for legacy state-based linking.
      const userWorkspace =
        project && project.organizationId !== null
          ? await firstOwnedOrgFor(userId)
          : null;

      const ownsProject =
        project &&
        (project.userId === userId ||
          (project.organizationId !== null &&
            userWorkspace !== null &&
            project.organizationId === userWorkspace.id));

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

    // Auto-PR — best effort, parallelized across repos. Idempotent on
    // re-installs (open-setup-pr handles existing branches/PRs via 422).
    const dsn = inariwatchDsnFor(installOrgId, userId);
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

    // Legacy redirect target was /integrations; that page was removed
    // 2026-05-06 (catalog cut). Send users to /projects where the
    // per-project Connected repository + Capture panels live.
    const back = new URL("/projects", APP_BASE);
    back.searchParams.set("github", "installed");
    if (firstPrUrl) back.searchParams.set("pr", firstPrUrl);
    return NextResponse.redirect(back);
  }

  // ── Vercel-style "Install from github.com" path ──────────────────────
  // No bulk import, no auto-PR. The user lands on /import where each
  // accessible repo is one explicit click away from becoming a project.
  // The per-repo server action (`addProjectFromRepo`) handles that.
  return NextResponse.redirect(new URL("/import?github=installed", APP_BASE));
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
  userId: string,
): Promise<{ id: string; userId: string } | null> {
  const rows = await db
    .select({
      userId: users.id,
      orgId:  organizations.id,
    })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .innerJoin(organizations,        eq(organizations.id,         organizationMembers.organizationId))
    .where(eq(users.id, userId))
    .orderBy(desc(sql`${organizations.ownerId} = ${users.id}`), asc(organizations.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.orgId, userId: row.userId };
}
