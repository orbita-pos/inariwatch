import type { Metadata } from "next";

import { MarketingNav } from "../marketing-nav";
import { Hero } from "./_components/Hero";
import { LocalAIDemo } from "./_components/LocalAIDemo";
import { ReceiptDemo } from "./_components/ReceiptDemo";
import { DownloadButtons } from "./_components/DownloadButtons";

const PAGE_TITLE = "Inari Live — Local-first AI for any editor";
const PAGE_DESCRIPTION =
  "Local by default. Cloud by choice. Provable always. Tab + Apply that run on your machine, cryptographic receipts on every change, works in any editor over LSP.";
const PAGE_URL = "https://inariwatch.com/inari-live";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    siteName: "InariWatch",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    site: "@inariwatch",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

export default function InariLivePage() {
  return (
    <main className="min-h-screen bg-inari-bg pb-32 text-fg-base">
      <MarketingNav opaque />
      <Hero />
      <LocalAIDemo />
      <ReceiptDemo />

      {/* ── Bottom CTA ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-3xl px-6 pt-8 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-fg-strong sm:text-3xl">
          Beta is free. No invite needed.
        </h2>
        <p className="mt-3 text-sm text-fg-muted">
          Pick the build that matches your machine. Updates ship signed and
          verified — Tauri Ed25519, Apple Developer ID, DigiCert EV, GPG for
          Linux.
        </p>
        <div className="mt-8 flex justify-center">
          <DownloadButtons variant="stack" />
        </div>
      </section>
    </main>
  );
}
