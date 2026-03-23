import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const BASE_URL = "https://inariwatch.com";

export const metadata: Metadata = {
  metadataBase:  new URL(BASE_URL),
  title:         { default: "InariWatch — Developer Monitoring", template: "%s | InariWatch" },
  description:   "InariWatch monitors GitHub, Vercel, Sentry and more. When something needs attention, you get one intelligent alert — not six.",
  keywords:      ["developer monitoring", "alerting", "github", "vercel", "sentry", "devops"],
  alternates:    { canonical: BASE_URL },

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
    url:         BASE_URL,
    siteName:    "InariWatch",
    title:       "InariWatch — Developer Monitoring",
    description: "Proactive alerts for GitHub, Vercel, Sentry and more. One intelligent alert instead of six.",
    images: [
      {
        url:    "/logo-inari/web-app-manifest-512x512.png",
        width:  512,
        height: 512,
        alt:    "InariWatch logo",
      },
    ],
  },

  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       "InariWatch — Developer Monitoring",
    description: "Proactive alerts for GitHub, Vercel, Sentry and more.",
    images:      ["/logo-inari/web-app-manifest-512x512.png"],
  },

  robots: {
    index:  true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type":       "Organization",
      "@id":         `${BASE_URL}/#organization`,
      name:          "InariWatch",
      url:           BASE_URL,
      logo:          `${BASE_URL}/logo-inari/favicon-96x96.png`,
      description:   "Developer monitoring platform. Proactive alerts for GitHub, Vercel, Sentry and more.",
    },
    {
      "@type":       "WebSite",
      "@id":         `${BASE_URL}/#website`,
      url:           BASE_URL,
      name:          "InariWatch",
      publisher:     { "@id": `${BASE_URL}/#organization` },
      potentialAction: {
        "@type":       "SearchAction",
        target:        `${BASE_URL}/alerts?q={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <script async src="https://plausible.io/js/pa-_2rUt9FS8WnW4yA3n6Ykd.js" />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`,
          }}
        />
      </head>
      <body className="bg-page text-fg-base antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
