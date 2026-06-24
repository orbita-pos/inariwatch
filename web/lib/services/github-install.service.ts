/**
 * GitHub App install status — single source of truth for "is this user
 * connected to GitHub?" Used by the dashboard banner, the import button
 * gating in the header / projects / integrations, and anywhere else
 * that needs to know whether to surface a connect CTA.
 *
 * "Connected" means: at least one live `githubAppInstallations` row that
 *   (a) the user installed personally (installedBy = userId), OR
 *   (b) belongs to a workspace the user is a member of.
 *
 * This mirrors `/import`'s install lookup so the two views can never
 * disagree (banner says "connect" but /import lists repos, or vice versa).
 */

import { db, githubAppInstallations, getUserOrganizations } from "@/lib/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

export async function userHasGitHubInstall(userId: string): Promise<boolean> {
  const userOrgs = await getUserOrganizations(userId);
  const orgIds   = userOrgs.map((o) => o.id);

  const [row] = await db
    .select({ id: githubAppInstallations.id })
    .from(githubAppInstallations)
    .where(
      and(
        isNull(githubAppInstallations.uninstalledAt),
        orgIds.length > 0
          ? or(
              eq(githubAppInstallations.installedBy, userId),
              inArray(githubAppInstallations.organizationId, orgIds),
            )
          : eq(githubAppInstallations.installedBy, userId),
      ),
    )
    .limit(1);

  return !!row;
}
