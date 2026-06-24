import type { Metadata } from "next";
import { MarketingNav } from "../marketing-nav";
import { VerifyClient } from "./verify-client";

const PAGE_TITLE = "Verify — InariWatch";
const PAGE_DESCRIPTION =
  "Verify any Inari AI fix receipt. Drop a .eap.json file, paste JSON, or open a shareable link to validate the Ed25519 signature offline in your browser.";
const PAGE_URL = "https://verify.inariwatch.com";

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

export default function VerifyPage() {
  return (
    <main className="min-h-screen bg-inari-bg pb-32 text-fg-base">
      <MarketingNav opaque />
      <section className="mx-auto max-w-3xl px-6 pt-28">
        <header className="mb-10">
          <span className="inline-flex items-center rounded-full border border-inari-border bg-inari-card px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
            verify.inariwatch.com
          </span>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-fg-strong">
            Verify any Inari AI fix receipt
          </h1>
          <p className="mt-3 text-base text-fg-muted">
            Drop a <code className="font-mono text-fg-strong">.eap.json</code>{" "}
            file or paste the JSON below. The signature is checked locally in
            your browser — nothing is uploaded.
          </p>
        </header>
        <VerifyClient />
        <Disclosure />
      </section>
    </main>
  );
}

function Disclosure() {
  return (
    <section className="mt-12 rounded-xl border border-inari-border bg-inari-card p-6 text-sm text-fg-muted">
      <h2 className="mb-3 font-semibold text-fg-strong">
        What the signature actually proves
      </h2>
      <ul className="space-y-2 leading-relaxed">
        <li>
          The Ed25519 signature commits to{" "}
          <code className="font-mono">SHA-256(receipt_id)</code>. The Merkle
          root commits to the recorded events. Together they prove the AI fix
          is the one the attestor signed against the events recorded.
        </li>
        <li>
          Metadata fields (<code className="font-mono">prompt_hash</code>,{" "}
          <code className="font-mono">tools</code>,{" "}
          <code className="font-mono">files_read</code>,{" "}
          <code className="font-mono">model</code>,{" "}
          <code className="font-mono">timestamp</code>) are display-only and{" "}
          <strong className="text-fg-strong">
            NOT cryptographically committed
          </strong>{" "}
          by the signature. Editing them does not invalidate the receipt — they
          are there so a human reading the file can see what the AI did.
        </li>
        <li>
          A Merkle-only receipt (no signature minted) is still tamper-evident
          on its own. The attestor identity is what the signature adds.
        </li>
      </ul>
    </section>
  );
}
