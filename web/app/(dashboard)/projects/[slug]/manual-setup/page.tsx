/**
 * Inari Live V1 — Session 4. Manual setup page.
 *
 * `/dashboard/projects/[slug]/manual-setup` — the path the web fallback
 * surfaces for users who don't (or won't) install Inari Live. The page:
 *   1. Resolves slug → project + workspace.
 *   2. Best-effort detects framework + host via the GitHub installation
 *      token (read package.json + the top-level tree). Falls back to
 *      `other` / `null` cleanly if the API hiccups so the user still
 *      sees the framework + host tabs.
 *   3. Renders the client component which mints a token via the existing
 *      S2 API, runs the SSE first-event listener, and walks the user
 *      through copy/paste setup.
 *
 * The token is shown ONCE (Rollbar pattern) — same UX the existing
 * `project-tokens-client.tsx` uses, lifted into a single-shot panel
 * so the user lands directly on the install steps without a modal hop.
 */

import { getServerSession } from "next-auth";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { and, eq } from "drizzle-orm";

import { authOptions } from "@/lib/auth";
import {
  db,
  projects,
  projectIntegrations,
  organizations,
  organizationMembers,
  githubAppInstallations,
} from "@/lib/db";
import { getInstallationToken } from "@/lib/github-app/octokit";
import {
  detectHostFromTopLevel,
  frameworkFromPackageJson,
  type FrameworkId,
  type HostId,
} from "@/lib/hosts";

import { ManualSetupClient } from "./manual-setup-client";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Manual setup" };

// Always re-fetch — the wizard delivery + first-event SSE depend on
// fresh state, and the token-mint trigger lives on the client.
export const dynamic = "force-dynamic";

export default async function ManualSetupPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    redirect(`/login?from=/dashboard/projects/${encodeURIComponent(slug)}/manual-setup`);
  }

  const [project] = await db
    .select({
      id:             projects.id,
      slug:           projects.slug,
      name:           projects.name,
      defaultRepo:    projects.defaultRepo,
      userId:         projects.userId,
      organizationId: projects.organizationId,
    })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (!project) notFound();

  // Authorization mirrors `[slug]/page.tsx`.
  let isAdmin = project.userId === userId;
  if (!isAdmin && project.organizationId) {
    const [orgRow] = await db
      .select({ ownerId: organizations.ownerId })
      .from(organizations)
      .where(eq(organizations.id, project.organizationId))
      .limit(1);
    if (orgRow?.ownerId === userId) isAdmin = true;

    if (!isAdmin) {
      const [member] = await db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, project.organizationId),
            eq(organizationMembers.userId, userId),
          ),
        )
        .limit(1);
      if (member && (member.role === "owner" || member.role === "admin")) {
        isAdmin = true;
      }
    }
  }
  if (!isAdmin) notFound();

  // Best-effort GitHub-side detection. Failures here are non-fatal — the
  // page still renders with `framework: "other"` / `host: null` and the
  // user picks a tab manually.
  const detection = await detectFromGithub(project);

  return (
    <div className="space-y-6 max-w-[920px]">
      <div>
        <Link
          href={`/projects/${project.slug}`}
          className="inline-flex items-center gap-1 text-[12.5px] text-fg-base/60 hover:text-fg-strong transition-colors"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          Back to {project.name}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold text-fg-strong tracking-tight">
          Manual setup
        </h1>
        <p className="mt-1 text-sm text-fg-base/60 max-w-[640px]">
          For teams that prefer it. We'll show you the exact steps to install{" "}
          <code className="font-mono text-[12px]">@inariwatch/capture</code>{" "}
          and add the env var to your host. Your first event lights this page
          up — no refresh needed.
        </p>
      </div>

      <ManualSetupClient
        projectId={project.id}
        projectSlug={project.slug}
        repoFullName={project.defaultRepo}
        detectedFramework={detection.framework}
        detectedHost={detection.host}
      />
    </div>
  );
}

interface DetectionHints {
  framework: FrameworkId;
  host:      HostId | null;
}

async function detectFromGithub(project: {
  id: string;
  defaultRepo: string | null;
}): Promise<DetectionHints> {
  if (!project.defaultRepo) {
    return { framework: "other", host: null };
  }

  const [installRow] = await db
    .select({
      installationId: projectIntegrations.installationId,
    })
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, project.id),
        eq(projectIntegrations.service, "github"),
      ),
    )
    .limit(1);
  if (!installRow?.installationId) {
    return { framework: "other", host: null };
  }
  // Confirm the install is still active — uninstalled rows would 401 below.
  const [install] = await db
    .select({ uninstalledAt: githubAppInstallations.uninstalledAt })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installRow.installationId))
    .limit(1);
  if (!install || install.uninstalledAt) {
    return { framework: "other", host: null };
  }

  let token: string;
  try {
    token = await getInstallationToken(installRow.installationId);
  } catch {
    return { framework: "other", host: null };
  }

  const [owner, repo] = project.defaultRepo.split("/");
  if (!owner || !repo) return { framework: "other", host: null };

  const headers = {
    Authorization: `token ${token}`,
    Accept:        "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  } as const;

  // Resolve default branch — git/trees needs an explicit ref.
  let defaultBranch = "main";
  try {
    const repoRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers, cache: "no-store" },
    );
    if (repoRes.ok) {
      const json = (await repoRes.json()) as { default_branch?: string };
      if (typeof json.default_branch === "string" && json.default_branch.length > 0) {
        defaultBranch = json.default_branch;
      }
    }
  } catch {
    // Fall through with `main`.
  }

  // Read package.json — first hit, raw content via the Contents API.
  let framework: FrameworkId = "other";
  try {
    const pkgRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/package.json?ref=${encodeURIComponent(defaultBranch)}`,
      { headers, cache: "no-store" },
    );
    if (pkgRes.ok) {
      const data = (await pkgRes.json()) as { content?: string; encoding?: string };
      if (data.content && data.encoding === "base64") {
        const decoded = Buffer.from(data.content, "base64").toString("utf8");
        try {
          framework = frameworkFromPackageJson(JSON.parse(decoded));
        } catch {
          // package.json malformed — leave as "other".
        }
      }
    }
  } catch {
    // Network blip — leave as "other".
  }

  // Top-level file list — Git Trees API, depth-1 ish (recursive=0).
  let host: HostId | null = null;
  try {
    const treeRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(defaultBranch)}`,
      { headers, cache: "no-store" },
    );
    if (treeRes.ok) {
      const data = (await treeRes.json()) as {
        tree?: Array<{ path: string; type: "blob" | "tree" }>;
      };
      const entries = (data.tree ?? [])
        .map((e) => (e.type === "tree" ? `${e.path}/` : e.path))
        .filter((p) => typeof p === "string");
      host = detectHostFromTopLevel(entries);
    }
  } catch {
    // Leave null — UI shows the dropdown.
  }

  return { framework, host };
}
