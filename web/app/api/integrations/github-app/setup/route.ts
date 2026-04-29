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
import { db, organizations, organizationMembers, users, githubAppInstallations } from "@/lib/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { getInstallationToken, ghFetch } from "@/lib/github-app/octokit";
import { openSetupPRForInstallation } from "@/lib/github-app/open-setup-pr";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const installationIdRaw = url.searchParams.get("installation_id");
  const setupAction       = url.searchParams.get("setup_action");

  if (!installationIdRaw) {
    return NextResponse.redirect(new URL("/integrations?error=missing_installation", url.origin));
  }
  const installationId = Number(installationIdRaw);
  if (!Number.isFinite(installationId)) {
    return NextResponse.redirect(new URL("/integrations?error=bad_installation", url.origin));
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    const loginUrl = new URL("/login", url.origin);
    loginUrl.searchParams.set("from", url.pathname + url.search);
    return NextResponse.redirect(loginUrl);
  }

  // Resolve installation account (User vs Organization, login, id).
  let token: string;
  let accountInfo: { login: string; type: string; id: number };
  try {
    token = await getInstallationToken(installationId);
    const res = await ghFetch(token, `/app/installations/${installationId}`);
    if (!res.ok) throw new Error(`installation: ${res.status}`);
    const json = (await res.json()) as { account: { login: string; type: string; id: number } };
    accountInfo = json.account;
  } catch (err) {
    console.error("[github-app] setup failed:", err);
    return NextResponse.redirect(new URL("/integrations?error=github_app_init", url.origin));
  }

  const orgRow = await firstOwnedOrgFor(session.user.email);
  if (!orgRow) {
    return NextResponse.redirect(new URL("/integrations?error=no_org", url.origin));
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

  // Mint the per-org DSN once — every PR we open in this run shares it.
  const dsn = inariwatchDsnForOrg(orgRow.id);

  // Open the auto-PR — best effort, parallelized across repos.
  let firstPrUrl: string | null = null;
  if (setupAction !== "update") {
    try {
      const prs = await openSetupPRForInstallation(token, dsn);
      firstPrUrl = prs[0]?.url ?? null;
      // Persist the first PR for the dashboard to surface.
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
  }

  // Land on the dedicated success page — shows the DSN, the PR link,
  // and "now go set INARIWATCH_DSN in your hosting provider" guidance.
  const redirect = new URL("/integrations/github-app/installed", url.origin);
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
