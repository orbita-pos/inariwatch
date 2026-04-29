// Tauri auto-updater manifest endpoint.
//
// Tauri's updater plugin polls this URL on app start. We answer with
// JSON pointing at the latest release's signed bundle. Spec:
//   https://tauri.app/v2/guide/distribute/updater/#static-json-file
//
// Query params (Tauri populates these):
//   target          — "darwin", "linux", "windows"
//   arch            — "x86_64" | "aarch64"
//   current_version — the user's current app version
//
// Response shape:
//   { version, notes, pub_date, platforms: { "darwin-x86_64": { url, signature }, … } }
//
// We pull the latest release from GitHub. If the user is already on the
// latest version we return 204 (No Update Available) per Tauri spec.

import { NextResponse } from "next/server";

interface ReleaseAsset { name: string; browser_download_url: string }
interface ReleaseInfo  {
  tag_name:     string;
  body?:        string;
  published_at: string;
  assets:       ReleaseAsset[];
}

const REPO = "orbita-pos/inariwatch";

export async function GET(req: Request) {
  const url    = new URL(req.url);
  const target = url.searchParams.get("target") ?? "";
  const arch   = url.searchParams.get("arch")   ?? "";
  const current = url.searchParams.get("current_version") ?? "";

  const release = await fetchLatestRelease();
  if (!release) {
    return new NextResponse(null, { status: 204 });
  }

  // Strip the "desktop-v" prefix our release tags use.
  const latestVersion = release.tag_name.replace(/^desktop-v/, "");
  if (current && versionGte(current, latestVersion)) {
    return new NextResponse(null, { status: 204 });
  }

  const platformKey = `${target}-${arch}`;
  const bundle = pickBundle(release.assets, target, arch);
  if (!bundle) {
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json({
    version:  latestVersion,
    notes:    release.body ?? "",
    pub_date: release.published_at,
    platforms: {
      [platformKey]: {
        url:       bundle.url,
        signature: bundle.signature,
      },
    },
  });
}

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const headers: Record<string, string> = {
      Accept:  "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = process.env.GITHUB_RELEASES_TOKEN;
    if (token) headers.Authorization = `token ${token}`;
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers, next: { revalidate: 300 } },
    );
    if (!res.ok) return null;
    return (await res.json()) as ReleaseInfo;
  } catch {
    return null;
  }
}

interface BundleEntry { url: string; signature: string }

function pickBundle(
  assets: ReleaseAsset[],
  target: string,
  arch:   string,
): BundleEntry | null {
  // Tauri produces an `.app.tar.gz` (mac), `.AppImage.tar.gz` (linux),
  // `.msi.zip` or `.nsis.zip` (windows) — each paired with a `.sig`.
  // We pick the bundle whose name matches target+arch and look up the
  // companion sig.
  const matchers: Record<string, RegExp> = {
    "darwin-x86_64":  /x64.*\.app\.tar\.gz$/i,
    "darwin-aarch64": /aarch64.*\.app\.tar\.gz$/i,
    "linux-x86_64":   /x86_64.*\.AppImage\.tar\.gz$/i,
    "linux-aarch64":  /aarch64.*\.AppImage\.tar\.gz$/i,
    "windows-x86_64": /x64.*\.(?:msi|nsis)\.zip$/i,
  };
  // Also support universal mac builds — some Tauri configs ship just one.
  const universalMac = /universal.*\.app\.tar\.gz$/i;

  const wanted = matchers[`${target}-${arch}`];
  let bundle: ReleaseAsset | undefined;
  if (wanted) {
    bundle = assets.find((a) => wanted.test(a.name));
  }
  if (!bundle && target === "darwin") {
    bundle = assets.find((a) => universalMac.test(a.name));
  }
  if (!bundle) return null;

  const sig = assets.find((a) => a.name === `${bundle!.name}.sig`);
  if (!sig) return null;

  return {
    url:       bundle.browser_download_url,
    signature: sig.browser_download_url, // Tauri fetches and validates
  };
}

function versionGte(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
