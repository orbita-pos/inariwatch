import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPreviewBySlug } from "@/lib/services/preview/session.service";
import { PreviewViewer } from "./viewer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Preview Fix — public capability page.
 *
 *   https://app.inariwatch.com/preview/<slug>
 *
 * Public: no auth. The 12-char base32 slug is the capability. Mirrors the
 * aesthetic of /attestation/[id]/page.tsx — a single-purpose, shareable
 * artifact page.
 *
 * Both tiers render here:
 *   - Tier 3 (AI-predicted HTML) — sandboxed iframe with watermark
 *   - Tier 1 (live ephemeral deploy) — iframe pointing at
 *     <hash>.staging.inariwatch.com
 *
 * The EAP receipt ID, when present, links to /attestation/<id> for
 * cryptographic chain verification — the "see the fix visually, verified
 * cryptographically" unified experience.
 */

const SLUG_REGEX = /^[A-Z2-7]{12}$/;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG_REGEX.test(slug)) return { title: "Preview not found — InariWatch" };

  const preview = await getPreviewBySlug(slug);
  if (!preview || preview.revokedAt) {
    return { title: "Preview unavailable — InariWatch" };
  }

  return {
    title: "Autonomous Fix Preview — InariWatch",
    description:
      "See the autonomous fix InariWatch deployed for a production bug. AI-predicted instantly, verified live in an ephemeral sandbox.",
    openGraph: {
      title: "Autonomous Fix Preview — InariWatch",
      description:
        "AI-generated preview + live deploy + cryptographic receipt, all at one URL.",
      images: [
        {
          url: `/api/preview/slug/${slug}/og`,
          width: 1200,
          height: 630,
          alt: "InariWatch autonomous fix preview",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Autonomous Fix Preview — InariWatch",
      description:
        "AI-generated preview + live deploy + cryptographic receipt, all at one URL.",
      images: [`/api/preview/slug/${slug}/og`],
    },
    robots: { index: false }, // Capability URLs shouldn't appear in search.
  };
}

export default async function PreviewPublicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!SLUG_REGEX.test(slug)) notFound();

  const preview = await getPreviewBySlug(slug);
  if (!preview) notFound();

  if (preview.revokedAt) {
    return (
      <main className="min-h-screen bg-bg text-fg-base">
        <div className="mx-auto max-w-2xl px-6 py-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[10px] uppercase tracking-wider text-fg-base/50">
            Preview revoked
          </div>
          <h1 className="mt-6 text-2xl font-semibold text-fg-strong">
            This preview has been revoked
          </h1>
          <p className="mt-3 text-sm text-fg-base/70">
            The workspace owner ended early access to this preview. The fix itself
            is still deployed in production.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg text-fg-base">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <header className="mb-8">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-fg-base/50 mb-2">
            <span>InariWatch</span>
            <span>·</span>
            <span>Preview Fix</span>
          </div>
          <h1 className="text-2xl font-semibold text-fg-strong">
            Autonomous fix preview
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-fg-base/70">
            InariWatch autonomously diagnosed a production bug, generated a fix,
            ran it through 17 safety gates, and deployed it. This page shows two
            views of the result: an AI-predicted render of the affected UI and a
            real live deploy of the fix branch in an ephemeral sandbox.
          </p>
          <code className="mt-3 block break-all rounded bg-surface-inner px-3 py-2 text-[11px] text-fg-strong font-mono">
            {slug}
          </code>
        </header>

        <Suspense
          fallback={
            <div className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-fg-base/60">
              Loading preview…
            </div>
          }
        >
          <PreviewViewer slug={slug} initialPreview={preview} />
        </Suspense>

        <footer className="mt-12 border-t border-line pt-6 text-[11px] text-fg-base/50 space-y-1">
          <p>
            AI predictions are computed from the last browser snapshot + the fix
            diff. The live build runs the actual fix branch in a sandboxed
            container — clicking inside it interacts with real code, with a 24h
            TTL.
          </p>
          <p>
            {preview.eapReceiptId ? (
              <>
                The fix itself is cryptographically signed. See the full EAP
                chain at{" "}
                <a
                  href={`/attestation/${preview.eapReceiptId}`}
                  className="text-inari-accent underline"
                >
                  /attestation/{preview.eapReceiptId.slice(0, 12)}…
                </a>
                .
              </>
            ) : (
              <>No EAP receipt is attached to this preview.</>
            )}
          </p>
          <p className="mt-3">
            <a href="https://inariwatch.com" className="text-inari-accent underline">
              Powered by InariWatch
            </a>
            {" · "}
            <a href="https://inariwatch.com/trust" className="text-inari-accent underline">
              How this works
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
