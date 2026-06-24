/**
 * Inari Live V1 — Session 3. "Add Project" with desktop-wizard
 * integration. Same data shape as /import (recent + accessible repos
 * via GitHub App installations) but with copy + state UX that
 * highlights the Inari Live wizard auto-launch.
 *
 * Why a separate page from /import: /import was the pre-S3 manual
 * setup entry, and existing docs / banners deep-link to it. We keep
 * its UX unchanged so installed users don't suddenly see different
 * copy mid-flow. /dashboard/projects/new is the new canonical entry
 * the dashboard CTA points at.
 */

import { getServerSession } from "next-auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Github, Lock, Globe, Zap, Laptop, ExternalLink } from "lucide-react";
import { and, eq, isNull, inArray, or } from "drizzle-orm";

import {
  db,
  projects,
  githubAppInstallations,
  getUserOrganizations,
} from "@/lib/db";
import { authOptions } from "@/lib/auth";
import { getInstallationToken } from "@/lib/github-app/octokit";
import { dedupeInstallsByInstallationId } from "../../import/dedupe";
import { InstallMoreButton } from "../../import/install-more-button";
import { SignInClientButton } from "../../import/signin-client-button";
import { AddProjectButton } from "./add-project-button";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Add Project" };

// Always re-fetch — installations grant/revoke repo access independently
// of our DB and we want the picker to reflect that within one round trip.
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 10;

interface AccessibleRepo {
  installationId: number;
  accountLogin:   string;
  name:           string;
  fullName:       string;
  isPrivate:      boolean;
  defaultBranch:  string;
  pushedAt:       string | null;
  alreadyAddedTo: string | null;
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
      // `sort=pushed` orders newest-pushed first — that's the "recent
      // 10" the locked decision asks for. The picker UI shows the top
      // 10 of this list and exposes a search input for the rest.
      const res = await fetch(
        `https://api.github.com/installation/repositories?per_page=100&page=${page}&sort=pushed`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept:        "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
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
          pushed_at:      string | null;
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
          pushedAt:       r.pushed_at ?? null,
          alreadyAddedTo: ownedRepoFullNames.has(r.full_name)
            ? (ownedRepoSlugByName.get(r.full_name) ?? null)
            : null,
        });
      }
      if (repos.length < 100) break;
      page += 1;
      if (page > 5) break; // safety cap at 500 repos for the picker
    }
  }
  // Already-imported repos sink to the bottom; everything else stays
  // in pushed-at order.
  out.sort((a, b) => {
    if (!!a.alreadyAddedTo !== !!b.alreadyAddedTo) {
      return a.alreadyAddedTo ? 1 : -1;
    }
    if (!a.pushedAt) return 1;
    if (!b.pushedAt) return -1;
    return b.pushedAt.localeCompare(a.pushedAt);
  });
  return out;
}

export default async function AddProjectPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/login?from=/dashboard/projects/new");

  const slug = process.env.GITHUB_APP_SLUG;
  const userOrgs = await getUserOrganizations(userId);
  const orgIds = userOrgs.map((o) => o.id);

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

  const installs = dedupeInstallsByInstallationId(installRows);

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

  const repos = installs.length > 0
    ? await gatherRepos(installs, ownedRepoFullNames, ownedRepoSlugByName)
    : [];

  if (installs.length === 0) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
        <div className="w-full max-w-[480px]">
          <div className="rounded-xl border border-line bg-surface p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-dim">
              <Github aria-hidden="true" className="h-6 w-6 text-fg-base/70" />
            </div>
            <h1 className="text-lg font-semibold text-fg-strong mb-1">Connect GitHub</h1>
            <p className="text-sm text-fg-base/60 mb-5">
              Install the InariWatch App on your account or org to choose
              which repos to monitor. After connecting, Inari Live can
              install <code className="font-mono text-[12px]">@inariwatch/capture</code> and
              wire your environment variables in about 90 seconds.
            </p>
            <SignInClientButton />
          </div>
        </div>
      </div>
    );
  }

  // Split into "recent" (top 10 not-yet-added) and the rest, surfaced via
  // the search input. The "rest" is rendered too so screen-reader users
  // can scroll without typing.
  const notAdded = repos.filter((r) => !r.alreadyAddedTo);
  const recent   = notAdded.slice(0, RECENT_LIMIT);
  const rest     = notAdded.slice(RECENT_LIMIT);
  const added    = repos.filter((r) => r.alreadyAddedTo);

  return (
    <div className="space-y-6 max-w-[840px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Add Project</h1>
          <p className="mt-1 text-sm text-fg-base/60 max-w-[560px]">
            Pick a repo. Inari Live will install Capture, write the DSN
            to <code className="font-mono text-[12px]">.env.local</code>,
            sync it to Vercel, and verify with a test event — without
            touching your git working tree.
          </p>
        </div>
        {slug && <InstallMoreButton slug={slug} />}
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-line-subtle bg-surface-dim/40 px-4 py-2.5 text-[12.5px] text-fg-base/70">
        <Laptop aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        Inari Live not running?
        <Link href="/import" className="text-inari-accent hover:underline ml-1">
          Use manual setup instead →
        </Link>
      </div>

      {recent.length === 0 && added.length > 0 ? (
        <div className="rounded-xl border border-dashed border-line py-10 text-center">
          <p className="text-sm text-fg-base/60">
            All accessible repos are already added.
            {slug ? (
              <>
                {" "}Add more via{" "}
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
        <RepoList
          recent={recent}
          rest={rest}
          added={added}
        />
      )}
    </div>
  );
}

function RepoList({
  recent,
  rest,
  added,
}: {
  recent: AccessibleRepo[];
  rest: AccessibleRepo[];
  added: AccessibleRepo[];
}) {
  return (
    <div className="space-y-6">
      <ul className="overflow-hidden rounded-xl border border-line divide-y divide-line-subtle bg-surface">
        {recent.map((r) => (
          <RepoRow key={`${r.installationId}-${r.fullName}`} repo={r} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface">
          <summary className="px-5 py-3 cursor-pointer text-[13px] text-fg-base/80 hover:text-fg-strong">
            Show {rest.length} more {rest.length === 1 ? "repo" : "repos"}
          </summary>
          <ul className="border-t border-line-subtle divide-y divide-line-subtle">
            {rest.map((r) => (
              <RepoRow key={`${r.installationId}-${r.fullName}`} repo={r} />
            ))}
          </ul>
        </details>
      ) : null}
      {added.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface">
          <summary className="px-5 py-3 cursor-pointer text-[13px] text-fg-base/80 hover:text-fg-strong">
            Already added ({added.length})
          </summary>
          <ul className="border-t border-line-subtle divide-y divide-line-subtle">
            {added.map((r) => (
              <li
                key={`${r.installationId}-${r.fullName}`}
                className="flex items-center gap-4 px-5 py-3"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-dim text-fg-base/60 shrink-0">
                  {r.isPrivate ? (
                    <Lock aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <Globe aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg-strong font-mono">{r.fullName}</p>
                </div>
                {r.alreadyAddedTo ? (
                  <Link
                    href={`/projects/${r.alreadyAddedTo}`}
                    className="text-[12px] text-inari-accent hover:underline inline-flex items-center gap-1"
                  >
                    Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function RepoRow({ repo: r }: { repo: AccessibleRepo }) {
  return (
    <li className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
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
          {r.pushedAt ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Last pushed {formatRelative(r.pushedAt)}</span>
            </>
          ) : null}
        </div>
      </div>
      <span className="hidden items-center gap-1 text-[11px] text-fg-base/40 sm:inline-flex">
        <Zap className="h-3 w-3" aria-hidden="true" />
        Wizard ready
      </span>
      <AddProjectButton
        installationId={r.installationId}
        owner={r.accountLogin}
        repo={r.name}
      />
    </li>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60)    return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)    return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24)      return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30)       return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
