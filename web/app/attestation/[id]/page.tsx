import { Suspense } from "react";
import type { Metadata } from "next";
import { AttestationViewer } from "./viewer";

export const revalidate = 3600;
export const runtime = "nodejs";

/**
 * VAR Q3 — Public Attestation page.
 *
 * https://app.inariwatch.com/attestation/<receipt_id>
 *
 * Anyone with a receipt ID can visit this URL and audit the full EAP
 * chain (Merkle-rooted, Ed25519-signed) that InariWatch emitted for an
 * autonomous remediation. No login, no gating — the URL itself is the
 * capability (the ID IS the hash). This is the visible surface of the
 * "verifiable forever" promise.
 */

export const metadata: Metadata = {
  title: "EAP Attestation — InariWatch",
  description:
    "Cryptographic proof of an autonomous remediation performed by InariWatch. Merkle-rooted, Ed25519-signed, independently verifiable.",
  robots: { index: false }, // Capability URLs shouldn't appear in search.
};

export default async function AttestationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="min-h-screen bg-bg text-fg-base">
      <div className="mx-auto max-w-4xl px-6 py-12">
        <header className="mb-8">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-fg-base/50 mb-2">
            <span>InariWatch</span>
            <span>·</span>
            <span>EAP Attestation</span>
          </div>
          <h1 className="text-2xl font-semibold text-fg-strong">
            Autonomous Remediation Receipt
          </h1>
          <p className="mt-2 text-sm text-fg-base/70 max-w-2xl">
            This page is a cryptographic record of an autonomous fix performed
            by InariWatch. The receipt below is content-addressed (the ID is
            the Merkle root of every I/O event the fix touched) and signed
            with an Ed25519 key. Anyone can reproduce the verification by
            replaying the recording and comparing the Merkle root.
          </p>
          <code className="mt-3 block break-all rounded bg-surface-inner px-3 py-2 text-[11px] text-fg-strong font-mono">
            {id}
          </code>
        </header>

        <Suspense
          fallback={
            <div className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-fg-base/60">
              Loading attestation…
            </div>
          }
        >
          <AttestationViewer receiptId={id} />
        </Suspense>

        <footer className="mt-12 border-t border-line pt-6 text-[11px] text-fg-base/50 space-y-1">
          <p>
            Receipts are immutable. Once emitted, their content cannot change —
            a tampered event would produce a different Merkle root, and
            consequently a different URL.
          </p>
          <p>
            The verification report above is computed server-side but the
            underlying receipt JSON is available via{" "}
            <code className="font-mono">
              GET /api/attestation/{id.slice(0, 12)}…
            </code>{" "}
            for independent re-verification.
          </p>
          <p className="mt-3">
            <a
              href="https://github.com/orbita-pos/eap"
              className="text-inari-accent underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              How EAP works
            </a>
            {" · "}
            <a href="https://inariwatch.com/trust" className="text-inari-accent underline">
              Trust &amp; compliance
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
