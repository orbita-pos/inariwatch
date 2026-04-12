import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { satoshi, clashDisplay } from "./fonts";

const BASE_URL           = "https://inariwatch.com";
const DEFAULT_TITLE       = "InariWatch — AI Monitoring That Fixes Your Code";
const DEFAULT_DESCRIPTION = "AI-powered monitoring for developers. InariWatch watches GitHub, Vercel, Sentry and more — then reads your code and writes the fix autonomously.";

export const metadata: Metadata = {
  metadataBase:  new URL(BASE_URL),
  title:         { default: DEFAULT_TITLE, template: "%s | InariWatch" },
  description:   DEFAULT_DESCRIPTION,
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

  manifest: "/logo-inari/site.webmanifest",

  openGraph: {
    type:        "website",
    url:         BASE_URL,
    siteName:    "InariWatch",
    title:       DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    // images auto-resolved from app/opengraph-image.tsx
  },

  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    // images auto-resolved from app/opengraph-image.tsx
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
      "@type":     "Organization",
      "@id":       `${BASE_URL}/#organization`,
      name:        "InariWatch",
      url:         BASE_URL,
      logo:        `${BASE_URL}/logo-inari/favicon-96x96.png`,
      description: "AI-powered monitoring for developers. Watches GitHub, Vercel, Sentry and more — then writes the fix autonomously.",
      sameAs: [
        "https://github.com/orbita-pos/inariwatch-capture",
        "https://twitter.com/inariwatch",
      ],
    },
    {
      "@type":   "WebSite",
      "@id":     `${BASE_URL}/#website`,
      url:       BASE_URL,
      name:      "InariWatch",
      publisher: { "@id": `${BASE_URL}/#organization` },
    },
    {
      "@type":              "SoftwareApplication",
      "@id":                `${BASE_URL}/#software`,
      name:                 "InariWatch",
      applicationCategory:  "DeveloperApplication",
      operatingSystem:      "Any",
      description:          DEFAULT_DESCRIPTION,
      url:                  BASE_URL,
      publisher:            { "@id": `${BASE_URL}/#organization` },
      offers: {
        "@type":        "Offer",
        price:          "0",
        priceCurrency:  "USD",
        availability:   "https://schema.org/InStock",
        description:    "Free during beta — full access, no credit card",
      },
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${satoshi.variable} ${clashDisplay.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Theme init — must run before any CSS evaluates to prevent light→dark flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.classList.add(t);document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.classList.add('dark');}})();`,
          }}
        />
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
