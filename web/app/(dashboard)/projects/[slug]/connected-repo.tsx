import { ExternalLink, Github } from "lucide-react";
import { db, projectIntegrations, githubAppInstallations } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";
import { DefaultRepoSection } from "./default-repo";

/**
 * Vercel-style "Connected repository" header for the project page.
 *
 * Replaces the old "GitHub goes under /integrations" model: the repo is
 * the project's primary connection, not a side feature, so we surface
 * it at the top of the project page with the install owner/repo and a
 * direct link to the GitHub installation manage page.
 *
 * The existing DefaultRepoSection (repo selector for remediation
 * fallback) lives under this header — kept for the "I want to override
 * which repo a project tracks" case and for users on legacy
 * PAT-backed integrations.
 */
export async function ConnectedRepoSection({
  projectId,
  isAdmin,
  defaultRepo,
}: {
  projectId: string;
  isAdmin: boolean;
  defaultRepo: string | null;
}) {
  // Read the github project_integration + the matching installation row.
  // The two-step lookup keeps the JOIN trivial and lets us treat the
  // "no install" case (empty card) the same as "no integration row".
  const [integration] = await db
    .select({
      id:              projectIntegrations.id,
      configEncrypted: projectIntegrations.configEncrypted,
      installationId:  projectIntegrations.installationId,
      isActive:        projectIntegrations.isActive,
    })
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "github"),
      ),
    )
    .limit(1);

  let owner: string | null = null;
  let installationId: number | null = null;
  let mode: "app" | "pat" | null = null;
  if (integration) {
    const cfg = decryptConfig(integration.configEncrypted);
    owner = (cfg.owner as string | undefined) ?? null;
    installationId = integration.installationId ?? null;
    mode = integration.installationId ? "app" : "pat";
  }

  // When the install row exists but the project_integrations row is
  // active, Treat the per-installation "manage on GitHub" deep link as
  // the canonical out-link. Falls back to the App's public landing if
  // installationId is null (legacy PAT integrations).
  let manageUrl: string | null = null;
  if (installationId) {
    manageUrl = `https://github.com/settings/installations/${installationId}`;
  } else {
    // Read the org-level install (if any) and link there. Same App slug.
    const slug = process.env.GITHUB_APP_SLUG;
    manageUrl = slug ? `https://github.com/apps/${slug}` : null;
  }

  // Verify the install row still exists (covers uninstall-since-import
  // races where the project_integrations row points at a stale id).
  let installAlive = false;
  if (installationId) {
    const [installRow] = await db
      .select({ id: githubAppInstallations.id, uninstalledAt: githubAppInstallations.uninstalledAt })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    installAlive = !!(installRow && installRow.uninstalledAt === null);
  }

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-line bg-surface p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-dim shrink-0">
              <Github aria-hidden="true" className="h-5 w-5 text-fg-base/70" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                Connected repository
              </p>
              {integration && owner ? (
                <p className="truncate font-mono text-sm text-fg-strong">
                  {defaultRepo ?? `${owner}/—`}
                </p>
              ) : (
                <p className="text-sm text-fg-base/60">Not connected</p>
              )}
            </div>
          </div>

          {integration ? (
            <div className="flex items-center gap-2 shrink-0">
              {mode === "app" && installAlive && (
                <span className="inline-flex items-center gap-1 rounded-full border border-green-500/20 bg-green-500/[0.05] px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" /> GitHub App
                </span>
              )}
              {mode === "pat" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/[0.05] px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  Legacy PAT
                </span>
              )}
              {mode === "app" && !installAlive && installationId && (
                <span className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/[0.05] px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                  Uninstalled
                </span>
              )}
              {manageUrl && (
                <a
                  href={manageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-line-medium bg-surface-dim px-2.5 py-1 text-[12px] text-fg-base hover:border-fg-base/30"
                >
                  Manage <ExternalLink aria-hidden="true" className="h-3 w-3" />
                </a>
              )}
            </div>
          ) : (
            <a
              href="/onboarding"
              className="shrink-0 inline-flex items-center gap-1 rounded-md bg-inari-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-inari-accent/90"
            >
              Connect
            </a>
          )}
        </div>
      </div>

      {/* The repo selector stays below as a sub-control: lets admins
          override the default repo for remediation when the install
          covers multiple repos and the alert source can't disambiguate. */}
      <DefaultRepoSection
        projectId={projectId}
        isAdmin={isAdmin}
        currentValue={defaultRepo}
      />
    </section>
  );
}
