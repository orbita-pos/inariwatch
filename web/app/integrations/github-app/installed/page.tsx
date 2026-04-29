// Confirmation page after a user installs the InariWatch GitHub App.
//
// The setup route (/api/integrations/github-app/setup) lands here after:
//   1. Persisting the installation,
//   2. Minting a per-org DSN,
//   3. Opening the auto-PR on each repo.
//
// We show:
//   - "Installed!" hero with a link to the PR (so they can merge in one click).
//   - The user's INARIWATCH_DSN with a copy button.
//   - Quick-links for the most common hosting providers.
//
// The DSN itself is not in the URL — we re-derive it from the user's org
// once they hit the page (server component, session-aware).

import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { authOptions } from "@/lib/auth";
import {
  db,
  organizations,
  organizationMembers,
  users,
  githubAppInstallations,
} from "@/lib/db";

import { CopyDsnButton } from "./copy-dsn-button";

interface PageProps {
  searchParams: Promise<{ pr?: string }>;
}

export default async function GithubAppInstalledPage({ searchParams }: PageProps) {
  // Defensive — every step gets a try/catch + log so we can see the
  // exact failure in `docker logs` when something goes wrong, instead
  // of Next.js's generic "Something went wrong" error boundary.
  let pr: string | undefined;
  try {
    const sp = await searchParams;
    pr = sp.pr;
  } catch (err) {
    console.error("[github-app/installed] searchParams failed:", err);
  }

  let session;
  try {
    session = await getServerSession(authOptions);
  } catch (err) {
    console.error("[github-app/installed] getServerSession threw:", err);
  }
  if (!session?.user?.email) {
    redirect("/login?from=/integrations/github-app/installed");
  }

  let orgRow: { id: string; userId: string } | null = null;
  try {
    orgRow = await firstOwnedOrgFor(session.user.email);
  } catch (err) {
    console.error("[github-app/installed] firstOwnedOrgFor threw:", err);
  }
  if (!orgRow) {
    redirect("/onboarding/workspace");
  }

  let installation: { setupPrUrl: string | null } | undefined;
  try {
    installation = (await db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.organizationId, orgRow.id))
      .orderBy(desc(githubAppInstallations.createdAt))
      .limit(1))[0];
  } catch (err) {
    console.error("[github-app/installed] installation lookup threw:", err);
  }

  const base = (
    process.env.APP_URL
      ?? process.env.NEXTAUTH_URL
      ?? process.env.NEXT_PUBLIC_APP_URL
      ?? "https://app.inariwatch.com"
  ).replace(/\/$/, "");
  const dsn = `${base}/capture/${orgRow.id}`;
  const prUrl = pr || installation?.setupPrUrl || null;

  return (
    <main className="min-h-screen bg-inari-bg text-inari-fg">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header className="mb-8">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Installed
          </div>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            InariWatch is set up on your repo.
          </h1>
          <p className="mt-3 text-inari-muted">
            Two more clicks and you&apos;re live — merge the PR we opened, then
            paste your DSN into your hosting provider&apos;s env vars.
          </p>
        </header>

        <section className="mb-6 rounded-2xl border border-inari-border bg-inari-surface-1 p-5">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-inari-muted">
            Step 1 — Merge the PR
          </h2>
          {prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-inari-accent px-4 py-2 text-sm font-medium text-inari-bg hover:opacity-90"
            >
              Open the PR on GitHub →
            </a>
          ) : (
            <p className="text-sm text-inari-muted">
              No PR was opened — your repo may already be set up, or the App
              has no write access. Check the{" "}
              <a className="underline" href={`https://github.com/settings/installations`}>
                App permissions on GitHub
              </a>
              .
            </p>
          )}
        </section>

        <section className="mb-6 rounded-2xl border border-inari-border bg-inari-surface-1 p-5">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-inari-muted">
            Step 2 — Set INARIWATCH_DSN in your hosting provider
          </h2>
          <p className="mb-3 text-sm text-inari-muted">
            Copy this and paste it into your hosting provider&apos;s
            environment-variable settings. Same value for all environments —
            production, preview, development.
          </p>
          <div className="flex items-center gap-2 rounded-xl border border-inari-border bg-inari-surface-2 p-3">
            <code className="flex-1 break-all font-mono text-xs">
              INARIWATCH_DSN={dsn}
            </code>
            <CopyDsnButton value={dsn} />
          </div>

          <h3 className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-inari-muted">
            Quick links
          </h3>
          <ul className="grid gap-2 text-sm md:grid-cols-2">
            <ProviderLink
              name="Vercel"
              hint="Project → Settings → Environment Variables"
              href="https://vercel.com/dashboard"
            />
            <ProviderLink
              name="Netlify"
              hint="Site settings → Environment variables"
              href="https://app.netlify.com/"
            />
            <ProviderLink
              name="Render"
              hint="Service → Environment → Add variable"
              href="https://dashboard.render.com/"
            />
            <ProviderLink
              name="Railway"
              hint="Project → Variables → New variable"
              href="https://railway.app/dashboard"
            />
            <ProviderLink
              name="Fly.io"
              hint="`flyctl secrets set INARIWATCH_DSN=…`"
              href="https://fly.io/docs/flyctl/secrets-set/"
            />
            <ProviderLink
              name="Heroku"
              hint="Settings → Config Vars"
              href="https://dashboard.heroku.com/apps"
            />
          </ul>
        </section>

        <section className="rounded-2xl border border-inari-border bg-inari-surface-1 p-5">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-inari-muted">
            That&apos;s it
          </h2>
          <p className="text-sm text-inari-muted">
            On the next deploy, every uncaught error will stream to{" "}
            <Link className="underline" href="/dashboard">
              your dashboard
            </Link>{" "}
            with AI auto-diagnosis attached. Self-hosting on Linux instead?{" "}
            <Link className="underline" href="/inari-live#daemon">
              install <code>inari-daemon</code>
            </Link>{" "}
            on the box and skip the env var entirely.
          </p>
        </section>
      </div>
    </main>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ProviderLink({ name, hint, href }: { name: string; hint: string; href: string }) {
  return (
    <li className="rounded-xl border border-inari-border bg-inari-surface-2 p-3">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:bg-inari-surface-3"
      >
        <div className="font-medium">{name}</div>
        <div className="text-xs text-inari-muted">{hint}</div>
      </a>
    </li>
  );
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
