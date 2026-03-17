import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title:       { default: "InariWatch — Developer Monitoring", template: "%s | InariWatch" },
  description: "InariWatch monitors GitHub, Vercel, Sentry and more. When something needs attention, you get one intelligent alert — not six.",
  keywords:    ["developer monitoring", "alerting", "github", "vercel", "sentry", "devops"],

  icons: {
    icon: [
      { url: "/logo-inari/favicon.ico",       sizes: "any" },
      { url: "/logo-inari/favicon-96x96.png", type: "image/png", sizes: "96x96" },
      { url: "/logo-inari/favicon.svg",        type: "image/svg+xml" },
    ],
    apple:    { url: "/logo-inari/apple-touch-icon.png", sizes: "180x180" },
    shortcut: "/logo-inari/favicon.ico",
  },

  manifest: "/site.webmanifest",

  openGraph: {
    type:        "website",
    siteName:    "InariWatch",
    title:       "InariWatch — Developer Monitoring",
    description: "Proactive alerts for GitHub, Vercel, Sentry and more. One intelligent alert instead of six.",
    images: [
      {
        url:    "/favicon/web-app-manifest-512x512.png",
        width:  512,
        height: 512,
        alt:    "InariWatch logo",
      },
    ],
  },

  twitter: {
    card:        "summary",
    title:       "InariWatch — Developer Monitoring",
    description: "Proactive alerts for GitHub, Vercel, Sentry and more.",
    images:      ["/favicon/web-app-manifest-512x512.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-inari-bg text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
