import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  db,
  projects,
  githubAppInstallations,
  getUserOrganizations,
} from "@/lib/db";
import { and, eq, isNull, inArray, or } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Github, Lock, Globe } from "lucide-react";
import { getInstallationToken } from "@/lib/github-app/octokit";
import { ImportRepoButton } from "./import-button";
import { InstallMoreButton } from "./install-more-button";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Import Repository" };

// We always re-fetch repos at request time — installations grant/revoke
// repo access independent of our DB and we want the list fresh.
export const dynamic = "force-dynamic";

interface AccessibleRepo {
  installationId: number;
  accountLogin:   string;
  name:           string;
  fullName:       string;
  isPrivate:      boolean;
  defaultBranch:  string;
  alreadyAddedTo: string | null; // project slug if already imported
}

async function gatherRepos(
  installs: { installationId: number; accountLogin: string }[],
  ownedRepoFullNames: Set<string>,
  ownedRepoSlugByName: Map<string, string>,
): Promise<AccessibleRepo[]> {
  const out: AccessibleRepo[] = [];
  for (const install of installs) {
    let token: string;
    try {
      token = await getInstallationToken(install.installationId);
    } catch {
      continue;
    }
    let page = 1;
    for (;;) {
      const res = await fetch(
        `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept:        "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          // Don't cache — we want a fresh list every page render.
          cache: "no-store",
        },
      );
      if (!res.ok) break;
      const json = (await res.json().catch(() => null)) as {
        repositories?: Array<{
          name:           string;
          full_name:      string;
          private:        boolean;
          default_branch: string;
          owner:          { login: string };
        }>;
      } | null;
      const repos = json?.repositories ?? [];
      for (const r of repos) {
        out.push({
          installationId: install.installationId,
          accountLogin:   install.accountLogin,
          name:           r.name,
          fullName:       r.full_name,
          isPrivate:      r.private,
          defaultBranch:  r.default_branch,
          alreadyAddedTo: ownedRepoFullNames.has(r.full_name)
            ? (ownedRepoSlugByName.get(r.full_name) ?? null)
            : null,
        });
      }
      if (repos.length < 100) break;
      page += 1;
      if (page > 10) break; // safety cap at 1000 repos
    }
  }
  // Sort: not-yet-imported first, then alphabetical.
  out.sort((a, b) => {
    if (!!a.alreadyAddedTo !== !!b.alreadyAddedTo) {
      return a.alreadyAddedTo ? 1 : -1;
    }
    return a.fullName.localeCompare(b.fullName);
  });
  return out;
}

export default async function ImportPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/login?from=/import");

  const slug = process.env.GITHUB_APP_SLUG;

  // Pull the user's installations. Two flavours surface here:
  //   1. Installs the user did personally (installedBy match)
  //   2. Installs that belong to an org the user is a member of
  // Both expose their repos via /installation/repositories with our App
  // installation token, so we union them in one query.
  const userOrgs = await getUserOrganizations(userId);
  const orgIds   = userOrgs.map((o) => o.id);

  const installRows = await db
    .select({
      installationId: githubAppInstallations.installationId,
      accountLogin:   githubAppInstallations.accountLogin,
    })
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
    );

  // Dedupe by installationId — a user who is BOTH the installer AND a
  // member of the install's org would otherwise see the row twice.
  const installSeen = new Map<number, { installationId: number; accountLogin: string }>();
  for (const r of installRows) installSeen.set(r.installationId, r);
  const installs = Array.from(installSeen.values());

  // Already-imported repos (any of the user's projects, regardless of
  // workspace) so the "Add" button flips to "Added" on hover.
  const userProjects = await db
    .select({ id: projects.id, slug: projects.slug, defaultRepo: projects.defaultRepo })
    .from(projects)
    .where(eq(projects.userId, userId));
  const ownedRepoFullNames = new Set(
    userProjects.filter((p) => p.defaultRepo).map((p) => p.defaultRepo!),
  );
  const ownedRepoSlugByName = new Map(
    userProjects
      .filter((p) => p.defaultRepo)
      .map((p) => [p.defaultRepo!, p.slug]),
  );

  const repos = installs.length > 0 ? await gatherRepos(installs, ownedRepoFullNames, ownedRepoSlugByName) : [];

  // No installations yet — show the "Install GitHub App" CTA. Same
  // signIn flow the dashboard banner uses.
  if (installs.length === 0) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
        <div className="w-full max-w-[480px] rounded-xl border border-line bg-surface p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-dim">
            <Github aria-hidden="true" className="h-6 w-6 text-fg-base/70" />
          </div>
          <h1 className="text-lg font-semibold text-fg-strong mb-1">Connect GitHub</h1>
          <p className="text-sm text-fg-base/60 mb-5">
            Install the InariWatch App on your account or org to choose which
            repos to monitor. You can add or remove repos any time from GitHub
            settings — no long-lived tokens, no PAT to expire.
          </p>
          <SignInButton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Import Repository</h1>
          <p className="mt-1 text-sm text-fg-base/60">
            {repos.length} {repos.length === 1 ? "repo" : "repos"} accessible
            {installs.length > 1 ? ` across ${installs.length} installations` : ""}.
            Click <em>Add</em> on any repo to start monitoring it.
          </p>
        </div>
        {slug && <InstallMoreButton slug={slug} />}
      </div>

      {repos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line py-16 text-center">
          <p className="text-sm text-fg-base/60">
            No repositories accessible by your installation.
            {slug ? (
              <>
                {" "}Add some via{" "}
                <a
                  href={`https://github.com/apps/${slug}/installations/new`}
                  className="text-inari-accent hover:text-inari-accent/80 underline-offset-2 hover:underline"
                >
                  github.com
                </a>
                .
              </>
            ) : null}
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line divide-y divide-line-subtle bg-surface">
          {repos.map((r) => (
            <li
              key={`${r.installationId}-${r.fullName}`}
              className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-dim text-fg-base/60 shrink-0">
                {r.isPrivate ? (
                  <Lock aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <Globe aria-hidden="true" className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg-strong font-mono">{r.fullName}</p>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-base/50">
                  <span>{r.isPrivate ? "Private" : "Public"}</span>
                  <span aria-hidden="true">·</span>
                  <span>{r.defaultBranch}</span>
                  {r.alreadyAddedTo && (
                    <>
                      <span aria-hidden="true">·</span>
                      <Link
                        href={`/projects/${r.alreadyAddedTo}`}
                        className="text-inari-accent hover:underline"
                      >
                        Open project →
                      </Link>
                    </>
                  )}
                </div>
              </div>
              <ImportRepoButton
                installationId={r.installationId}
                owner={r.accountLogin}
                repo={r.name}
                alreadyAdded={!!r.alreadyAddedTo}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Server-component wrapper that punts the click to a client component;
// the page can't call signIn() (server) so the actual button is in a
// client file imported here.
import { SignInClientButton } from "./signin-client-button";

function SignInButton() {
  return <SignInClientButton />;
}
