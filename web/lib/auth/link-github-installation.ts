/**
 * Auto-link GitHub App installations on user sign-in.
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
 * user has at least one installation of our App, we persist a
 * githubAppInstallations row for each. We do NOT bulk-import repos —
 * the user picks them explicitly on /import (Vercel-style).
 *
 * Soft-fail by design: if the access token isn't App-scoped (we're
 * still on the legacy OAuth App credentials) or the API rejects, we
 * just skip and the user lands on /import with the "no installations
 * yet" CTA, which kicks off the App-install OAuth.
 */

import { db, githubAppInstallations, users } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";

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

  // Persist installation rows (idempotent). No bulk repo import — users
  // pick repos explicitly on /import so the flow is visible. The install
  // row alone is enough for /import to list accessible repos via
  // /installation/repositories at render time.
  for (const install of ours) {
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
  }

  // Pin activeOrgId for legacy accounts that still have it null. Skipped
  // for personal-mode users (organizationId === null is correct for them).
  if (args.organizationId) {
    await db
      .update(users)
      .set({ activeOrgId: args.organizationId })
      .where(and(eq(users.id, args.userId), sql`${users.activeOrgId} IS NULL`));
  }

  return ours.length;
}
