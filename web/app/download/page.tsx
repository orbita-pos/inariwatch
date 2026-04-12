import Image from "next/image";
import Link from "next/link";
import { MarketingNav } from "../(marketing)/marketing-nav";
import type { Metadata } from "next";

const PAGE_TITLE       = "Download InariWatch Bot";
const PAGE_DESCRIPTION = "Get InariWatch Bot on your phone — push alerts, AI diagnosis, fix from anywhere.";
const PAGE_URL         = "https://inariwatch.com/download";

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

const FEATURES = [
  { emoji: "\uD83D\uDD14", text: "Push alerts 24/7" },
  { emoji: "\uD83D\uDD27", text: "Fix in one tap" },
  { emoji: "\uD83E\uDDE0", text: "Ask Inari AI" },
  { emoji: "\uD83D\uDCCA", text: "Uptime & status" },
];

export default function DownloadPage() {
  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav opaque />
      <main className="flex min-h-[calc(100vh-8rem)] items-center justify-center p-6">
        <div className="max-w-md w-full space-y-8 text-center">
          {/* Logo */}
          <div>
            <Image
              src="/logo-inari/favicon-96x96.png"
              alt=""
              width={80}
              height={80}
              className="mb-4 mx-auto"
            />
            <h1 className="text-3xl font-bold text-fg-strong">InariWatch Bot</h1>
            <p className="mt-2 text-fg-base text-lg">
              Production alerts. AI diagnosis. Fix from your phone.
            </p>
          </div>

          {/* Features */}
          <ul className="grid grid-cols-2 gap-3 text-left">
            {FEATURES.map((f) => (
              <li
                key={f.text}
                className="flex items-center gap-2 rounded-lg border border-inari-border bg-inari-card px-3 py-2"
              >
                <span aria-hidden="true">{f.emoji}</span>
                <span className="text-sm text-fg-strong">{f.text}</span>
              </li>
            ))}
          </ul>

          {/* Download buttons */}
          <div className="space-y-3">
            <a
              href="https://expo.dev/accounts/jesusdev21/projects/inariwatch-bot/builds/f6c39cac-5dda-4d48-b5ed-dfea2ae4b24d"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-inari-accent px-6 py-4 text-white font-semibold text-lg hover:bg-inari-accent/90 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.6 11.6l1.6-2.8c.1-.2 0-.4-.2-.5s-.4 0-.5.2l-1.6 2.8c-1.2-.5-2.5-.8-3.9-.8s-2.7.3-3.9.8L7.5 8.5c-.1-.2-.3-.3-.5-.2s-.3.3-.2.5l1.6 2.8C5.4 13.2 3.4 16.1 3 19.5h18c-.4-3.4-2.4-6.3-5.4-7.9zM8.5 16.5c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm7 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z" />
              </svg>
              Download for Android
            </a>

            <a
              href="https://testflight.apple.com/join/inariwatch"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full rounded-xl border border-inari-border bg-inari-card px-6 py-4 text-fg-strong font-semibold text-lg hover:bg-surface-inner transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
              </svg>
              Join TestFlight (iOS)
            </a>
          </div>

          {/* Info */}
          <div className="space-y-2 text-sm text-fg-base">
            <p>Android: Download the APK and enable &quot;Install from unknown sources&quot;</p>
            <p>iOS: TestFlight handles everything — just tap &quot;Join&quot;</p>
          </div>

          {/* Version */}
          <div className="pt-4 border-t border-inari-border">
            <p className="text-xs text-fg-base/60">InariWatch Bot v1.0.0</p>
            <Link href="/" className="text-xs text-inari-accent hover:underline">
              Back to InariWatch
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
