// Inari Live download page.
//
// Public landing for the desktop monitoring app. Auto-detects the user's
// platform (macOS/Windows/Linux) and shows the right download button up
// front, with the others as fallbacks. Pulls the latest release from
// GitHub at build time so we don't bake version numbers into source.
//
// SEO copy emphasizes the "doesn't touch your codebase" wedge.

import Link from "next/link";
import type { Metadata } from "next";
import { MarketingNav } from "../(marketing)/marketing-nav";

const PAGE_TITLE       = "Inari Live — monitoring that doesn't touch your codebase";
const PAGE_DESCRIPTION =
  "Drop-in error monitoring for Node.js. Zero npm install, zero config files, zero bundle weight. Connect your project, ship your code, fix in real time.";
const PAGE_URL         = "https://inariwatch.com/inari-live";

export const metadata: Metadata = {
  title:       PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates:  { canonical: PAGE_URL },
  openGraph: {
    type:        "website",
    url:         PAGE_URL,
    siteName:    "InariWatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

interface ReleaseAsset { name: string; browser_download_url: string }
interface ReleaseInfo  { tag_name: string; assets: ReleaseAsset[] }

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  // Cache for 5 min — release cadence is slow, no need to hit GitHub on
  // every render.
  try {
    const res = await fetch(
      "https://api.github.com/repos/orbita-pos/inariwatch/releases/latest",
      { next: { revalidate: 300 } },
    );
    if (!res.ok) return null;
    return (await res.json()) as ReleaseInfo;
  } catch {
    return null;
  }
}

interface PlatformLink {
  os:    "macOS" | "Windows" | "Linux";
  label: string;
  matcher: (asset: ReleaseAsset) => boolean;
}

const PLATFORMS: PlatformLink[] = [
  { os: "macOS",   label: "Download for Mac (Apple Silicon + Intel)", matcher: (a) => /\.dmg$/i.test(a.name) },
  { os: "Windows", label: "Download for Windows",                      matcher: (a) => /\.(msi|exe)$/i.test(a.name) },
  { os: "Linux",   label: "Download AppImage",                          matcher: (a) => /\.AppImage$/i.test(a.name) },
];

export default async function InariLivePage() {
  const release = await fetchLatestRelease();
  const downloads = PLATFORMS.map((p) => {
    const asset = release?.assets.find(p.matcher);
    return { ...p, url: asset?.browser_download_url ?? null, version: release?.tag_name ?? null };
  });

  return (
    <div className="min-h-screen bg-inari-bg text-inari-fg">
      <MarketingNav opaque />
      <main className="mx-auto max-w-4xl px-6 pb-20 pt-12">
        <header className="mb-12 text-center">
          <h1 className="mb-4 text-4xl font-semibold tracking-tight md:text-5xl">
            Inari Live
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-inari-muted">
            Monitoring that doesn&apos;t touch your codebase. Zero{" "}
            <code>npm install</code>, zero <code>instrumentation.ts</code>,
            zero bundle weight. Same architecture Dynatrace built for
            Fortune 500s — packaged for solo developers.
          </p>
        </header>

        <section className="mb-12 rounded-2xl border border-inari-border bg-inari-surface-1 p-6">
          <h2 className="mb-4 text-xl font-medium">Download</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {downloads.map((d) => (
              <a
                key={d.os}
                href={d.url ?? "#"}
                aria-disabled={!d.url}
                className={
                  d.url
                    ? "rounded-xl border border-inari-border bg-inari-surface-2 p-4 transition hover:border-inari-accent hover:bg-inari-surface-3"
                    : "pointer-events-none rounded-xl border border-inari-border bg-inari-surface-2 p-4 opacity-50"
                }
              >
                <div className="text-sm font-medium">{d.os}</div>
                <div className="mt-1 text-xs text-inari-muted">{d.label}</div>
                {d.version && (
                  <div className="mt-2 font-mono text-[11px] text-inari-muted">
                    {d.version}
                  </div>
                )}
              </a>
            ))}
          </div>
          {!release && (
            <p className="mt-4 text-sm text-inari-muted">
              No public release yet — check back soon, or grab the source
              at{" "}
              <a
                className="underline"
                href="https://github.com/orbita-pos/inariwatch"
              >
                github.com/orbita-pos/inariwatch
              </a>
              .
            </p>
          )}
        </section>

        <section className="mb-12 grid gap-6 md:grid-cols-3">
          <Feature
            title="Dev mode"
            body="Pick a folder. Inari Live launches your npm run dev with the SDK injected. Errors stream into the dock in real time."
          />
          <Feature
            title="Production (GitHub)"
            body="Install our GitHub App. We open one PR adding instrumentation. You merge, paste the DSN into your hosting provider, ship. Works on Vercel, Netlify, Render, Railway, Fly, Heroku — anywhere."
          />
          <Feature
            title="Linux server"
            body="One curl command installs the daemon. Every node systemd service on the box gets monitored automatically."
          />
        </section>

        <section className="mb-12 rounded-2xl border border-inari-border bg-inari-surface-1 p-6">
          <h2 className="mb-3 text-lg font-medium">How it works</h2>
          <p className="mb-3 text-sm text-inari-muted">
            We never modify your repository or your <code>node_modules</code>.
            Inari Live ships its own copy of <code>@inariwatch/capture</code>,
            and starts your app via <code>NODE_OPTIONS=--import</code>. The
            SDK initializes once at boot, captures errors and stack traces,
            and posts them to your DSN — same wire format we&apos;ve used
            in production since 2026.
          </p>
          <p className="text-sm text-inari-muted">
            Same approach as Dynatrace OneAgent for Linux self-host
            (<code>inari-daemon</code>): the daemon watches the kernel
            netlink proc-connector for <code>node</code> exec events,
            identifies the systemd unit, and writes a drop-in injecting{" "}
            <code>NODE_OPTIONS=--require</code>. Your unit file stays
            untouched; <code>inari-daemon uninstall</code> removes
            everything cleanly.
          </p>
        </section>

        <section className="text-center text-sm text-inari-muted">
          <p>
            Skip the desktop app and go straight to production?{" "}
            <a className="underline" href="https://github.com/apps/inariwatch/installations/new">
              install the GitHub App
            </a>
            .
          </p>
          <p className="mt-2">
            Self-hosting on Linux?{" "}
            <Link className="underline" href="/docs/daemon">
              one-line install for inari-daemon
            </Link>
            .
          </p>
        </section>
      </main>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-inari-border bg-inari-surface-1 p-5">
      <h3 className="mb-2 text-base font-medium">{title}</h3>
      <p className="text-sm text-inari-muted">{body}</p>
    </div>
  );
}
