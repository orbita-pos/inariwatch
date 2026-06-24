/**
 * S12 — root layout for the mobile PWA.
 *
 * Sets the manifest, web-app-capable meta tags, and registers the
 * service worker. The layout is intentionally framework-light: no
 * navbar, no global ThemeProvider — the mobile PWA has its own
 * minimal styling so it stays under the perf budget on a Pixel 4a
 * (S12_PROMPT.md "Verificación honesta de UX").
 */

import type { Metadata, Viewport } from "next";
import Script from "next/script";

export const metadata: Metadata = {
  title:       "Inari Mobile",
  description: "Pair your phone with Inari Live for alerts and chat.",
  manifest:    "/mobile/manifest.webmanifest",
  appleWebApp: {
    capable:     true,
    title:       "Inari",
    statusBarStyle: "default",
  },
  icons: {
    icon:  "/mobile/icon.svg",
    apple: "/mobile/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor:           "#0e0e10",
  initialScale:         1,
  width:                "device-width",
  maximumScale:         1,
  userScalable:         false,
  viewportFit:          "cover",
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-mobile-shell className="min-h-screen bg-[#0e0e10] text-[#f5f5f7]">
      {children}
      {/*
        Register the service worker once on first paint. Use `next/script`
        with strategy=afterInteractive so the registration doesn't block
        first paint of the inbox.
      */}
      <Script
        id="mobile-sw-register"
        strategy="afterInteractive"
      >
        {`
          if ("serviceWorker" in navigator && location.protocol === "https:") {
            window.addEventListener("load", () => {
              navigator.serviceWorker
                .register("/mobile/sw.js", { scope: "/mobile/" })
                .catch(() => undefined);
            });
          }
        `}
      </Script>
    </div>
  );
}
