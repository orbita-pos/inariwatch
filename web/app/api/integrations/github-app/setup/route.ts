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

  const orgRow = await firstOwnedOrgFor(session.user.email);
  if (!orgRow) {
    return NextResponse.redirect(new URL("/integrations?error=no_org", APP_BASE));
  }

  // Persist the installation row first so failures in the auto-PR step
  // don't lose the link.
  await db
    .insert(githubAppInstallations)
    .values({
      organizationId:  orgRow.id,
      installationId,
      accountLogin:    accountInfo.login,
      accountType:     accountInfo.type,
      accountId:       accountInfo.id,
      installedBy:     orgRow.userId,
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
        (project.userId === orgRow.userId ||
          (project.organizationId !== null && project.organizationId === orgRow.id));

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

  // Mint the per-org DSN once — every PR we open in this run shares it.
  const dsn = inariwatchDsnForOrg(orgRow.id);

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

  const redirect = new URL("/integrations/github-app/installed", APP_BASE);
  if (firstPrUrl) redirect.searchParams.set("pr", firstPrUrl);
  return NextResponse.redirect(redirect);
}

/**
 * Build the per-org Capture DSN. Format mirrors what the SDK expects:
 *   https://<workspace-slug>@app.inariwatch.com/capture/<org-id>
 * The trailing path segment is parsed at our /capture webhook to attribute
 * events to the right workspace; the secret part is reserved for HMAC
 * signing once we wire it up post-launch.
 */
function inariwatchDsnForOrg(orgId: string): string {
  const base = process.env.APP_URL ?? "https://app.inariwatch.com";
  return `${base.replace(/\/$/, "")}/capture/${orgId}`;
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
