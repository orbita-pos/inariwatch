import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Check, Sparkles, Building2, X } from "lucide-react";
import { headers } from "next/headers";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "../marketing-nav";
import type { Metadata } from "next";

const PAGE_TITLE       = "Pricing — InariWatch";
const PAGE_DESCRIPTION = "Free forever for indie devs. Pro $12/mo for production. Same features in both plans — Pro unlocks more monthly AI usage.";
const PAGE_URL         = "https://inariwatch.com/pricing";

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
    // images auto-resolved from app/opengraph-image.tsx
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

// Same features for both plans — only AI usage limits differ.
const SHARED_FEATURES = [
  "Unlimited alert ingestion",
  "Unlimited projects + integrations",
  "Pattern detection + community fix lookup",
  "Cross-project correlation",
  "Code intelligence (semantic search)",
  "Substrate I/O recordings",
  "11 safety gates + trust levels",
  "Slack + Telegram bots",
  "VS Code extension",
  "Mobile + desktop apps",
  "MCP server (25 tools)",
  "Capture SDK + InariWatch Agent",
  "Status page automation",
  "Workspace + team invites",
];

const FREE_LIMITS = [
  { feature: "Auto-analyses",     limit: "300/mo"            },
  { feature: "AI Remediations",   limit: "3/mo"              },
  { feature: "Ask Inari (chat)",  limit: "100 messages/mo"   },
  { feature: "PR Predictions",    limit: "10/mo"             },
  { feature: "AI Postmortems",    limit: "5/mo"              },
];

const PRO_LIMITS = [
  { feature: "Auto-analyses",     limit: "3,000/mo (10×)"     },
  { feature: "AI Remediations",   limit: "25/mo (8×)"         },
  { feature: "Ask Inari (chat)",  limit: "500 messages/mo (5×)" },
  { feature: "PR Predictions",    limit: "30/mo (3×)"         },
  { feature: "AI Postmortems",    limit: "50/mo (10×)"        },
];

const PRO_EXTRAS = [
  "Email support",
  "Annual billing: $120/year (save $24)",
];

const FAQS = [
  {
    q: "What happens when I hit a quota limit on free?",
    a: "Auto-analyses, predictions, and postmortems just stop running silently for the rest of the month — your alerts still come through, just without AI summary. Remediations and chat show an upgrade message. Everything resets day 1 of next month.",
  },
  {
    q: "Why is the free tier so generous?",
    a: "Because every user makes the product better. When you fix a bug, that fix is anonymized and added to the Community Fix Network — so the next person with the same bug sees \"X teams fixed this in Y minutes\". More users → more fixes → smarter AI for everyone.",
  },
  {
    q: "Do I need my own AI key?",
    a: "No. All AI features — auto-analysis, chat, remediation, postmortems — work out of the box. We fund the AI (GPT-4o-mini for analysis, GPT-5.4 for code fixes). Optionally, add your own key in Settings to use a specific provider (Claude, Grok, DeepSeek) or for higher rate limits.",
  },
  {
    q: "Why $12 — what's the catch?",
    a: "No catch. We're a small team, and $12 covers our auto-analysis costs plus a thin margin. Pricing might go up later as we add more features, but early users keep their rate.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Cancel from your billing portal — your Pro quotas stay active until the end of the billing period, then you go back to Free. No strings.",
  },
  {
    q: "How do quotas work in a team workspace?",
    a: "Quotas are per-user, not per-workspace. Each team member has their own monthly limits (e.g., 25 remediations). Whoever clicks \"Fix It\" uses their quota. Workspaces share projects and alerts, but quotas and AI keys are individual.",
  },
  {
    q: "What's the difference vs Sentry / Datadog / etc.?",
    a: "We don't just monitor — we fix. AI auto-diagnoses every alert, runs through 11 safety gates, generates a fix, opens a PR, and waits for CI. None of the legacy tools do this. And the Community Fix Network gets smarter every week.",
  },
] as const;

// ── JSON-LD (FAQPage + Product) ───────────────────────────────────────────────

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type":       "FAQPage",
      "@id":         `${PAGE_URL}/#faq`,
      mainEntity:    FAQS.map((f) => ({
        "@type":         "Question",
        name:            f.q,
        acceptedAnswer:  { "@type": "Answer", text: f.a },
      })),
    },
    {
      "@type":             "Product",
      "@id":               `${PAGE_URL}/#product`,
      name:                "InariWatch Pro",
      description:         "AI-powered monitoring with autonomous remediation. Pro unlocks higher monthly AI quotas.",
      brand:               { "@type": "Brand", name: "InariWatch" },
      offers: [
        {
          "@type":        "Offer",
          name:           "Free",
          price:          "0",
          priceCurrency:  "USD",
          availability:   "https://schema.org/InStock",
          url:            PAGE_URL,
          description:    "Free forever for indie devs and side projects.",
        },
        {
          "@type":        "Offer",
          name:           "Pro Monthly",
          price:          "12.00",
          priceCurrency:  "USD",
          availability:   "https://schema.org/InStock",
          url:            PAGE_URL,
          description:    "$12/month — 10× auto-analyses, 8× remediations, 5× chat.",
        },
        {
          "@type":        "Offer",
          name:           "Pro Annual",
          price:          "120.00",
          priceCurrency:  "USD",
          availability:   "https://schema.org/InStock",
          url:            PAGE_URL,
          description:    "$120/year — save $24 vs monthly (2 months free).",
        },
      ],
    },
  ],
};

export default async function PricingPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav opaque />

      <script
        nonce={nonce}
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <main>
        {/* Hero */}
        <section className="relative pt-32 pb-12 sm:pt-40 sm:pb-16">
          <div className="absolute inset-0 bg-radial-fade opacity-30" aria-hidden="true" />
          <div className="relative mx-auto max-w-4xl px-6 text-center">
            <h1 className="text-4xl font-bold tracking-tight text-fg-strong sm:text-6xl leading-[1.05]">
              Generous free tier.
              <br />
              <span className="text-gradient-accent glow-accent-text">Pro for production.</span>
            </h1>

            <p className="mt-6 text-lg text-fg-base max-w-2xl mx-auto leading-relaxed">
              All Pro features are free during beta. No credit card needed.
              When we launch, Pro will be $12/month. Early users get a special rate.
            </p>
          </div>
        </section>

        {/* Plans */}
        <section aria-labelledby="plans-heading" className="pb-20">
          <h2 id="plans-heading" className="sr-only">Plans</h2>
          <div className="mx-auto max-w-5xl px-6">
            <div className="grid gap-6 lg:grid-cols-2">

              {/* Free plan */}
              <div className="rounded-2xl border border-inari-border bg-inari-card p-8 flex flex-col">
                <div className="mb-6">
                  <h3 className="text-xl font-bold text-fg-strong">Free</h3>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-5xl font-bold text-fg-strong font-mono">$0</span>
                    <span className="text-fg-base text-sm">/month forever</span>
                  </div>
                  <p className="mt-2 text-sm text-fg-base">For indie devs and side projects.</p>
                </div>

                <div className="mb-6">
                  <p className="text-xs font-semibold text-fg-base/80 uppercase tracking-wider mb-3">
                    Monthly AI quotas
                  </p>
                  <ul className="space-y-2">
                    {FREE_LIMITS.map((item) => (
                      <li key={item.feature} className="flex items-baseline justify-between text-sm">
                        <span className="text-fg-base">{item.feature}</span>
                        <span className="font-mono text-fg-strong">{item.limit}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mb-8 flex-1">
                  <p className="text-xs font-semibold text-fg-base/80 uppercase tracking-wider mb-3">
                    Everything in Pro, except
                  </p>
                  <ul className="space-y-1.5">
                    <li className="flex items-start gap-2 text-sm text-fg-base">
                      <X className="h-4 w-4 text-fg-base/50 shrink-0 mt-0.5" aria-hidden="true" />
                      No email support
                    </li>
                  </ul>
                </div>

                <Link href="/register">
                  <Button variant="outline" className="w-full py-3 border-inari-border">
                    Start free
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Button>
                </Link>
              </div>

              {/* Pro plan */}
              <div className="rounded-2xl border-2 border-inari-accent/40 bg-inari-card p-8 flex flex-col relative">
                <div className="absolute -top-3 left-6 flex gap-2">
                  <span className="bg-inari-accent text-white text-xs font-mono font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                    Recommended
                  </span>
                  <span className="bg-emerald-500 text-white text-xs font-mono font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                    Free during beta
                  </span>
                </div>

                <div className="mb-6">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-inari-accent" aria-hidden="true" />
                    <h3 className="text-xl font-bold text-fg-strong">Pro</h3>
                  </div>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-5xl font-bold text-fg-strong font-mono line-through opacity-40">$12</span>
                    <span className="text-3xl font-bold text-emerald-500 font-mono ml-2">$0</span>
                    <span className="text-fg-base text-sm">/month during beta</span>
                  </div>
                  <p className="mt-2 text-sm text-fg-base">
                    Will be <span className="text-inari-accent font-semibold">$12/month</span> or <span className="text-inari-accent font-semibold">$120/year</span> after beta
                  </p>
                </div>

                <div className="mb-6">
                  <p className="text-xs font-semibold text-fg-base/80 uppercase tracking-wider mb-3">
                    Monthly AI quotas
                  </p>
                  <ul className="space-y-2">
                    {PRO_LIMITS.map((item) => (
                      <li key={item.feature} className="flex items-baseline justify-between text-sm">
                        <span className="text-fg-base">{item.feature}</span>
                        <span className="font-mono text-inari-accent">{item.limit}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mb-8 flex-1">
                  <p className="text-xs font-semibold text-fg-base/80 uppercase tracking-wider mb-3">
                    Plus
                  </p>
                  <ul className="space-y-1.5">
                    {PRO_EXTRAS.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-sm text-fg-base">
                        <Check className="h-4 w-4 text-inari-accent shrink-0 mt-0.5" aria-hidden="true" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <Link href="/register">
                  <Button variant="primary" className="w-full py-3">
                    Get started — free during beta
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Button>
                </Link>
              </div>

            </div>

            {/* AI callout */}
            <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-5 flex items-start gap-3">
              <Sparkles className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-fg-strong">All AI features included — no API key required</p>
                <p className="mt-1 text-xs text-fg-base leading-relaxed">
                  Every feature works out of the box. We fund the AI (GPT-4o-mini for analysis, GPT-5.4 for code fixes).
                  Optionally, bring your own key from Claude, Grok, or DeepSeek to use specific models.
                </p>
              </div>
            </div>

            {/* Shared features list */}
            <div className="mt-6 rounded-xl border border-inari-border bg-inari-card p-8">
              <h3 className="text-sm font-semibold text-fg-strong mb-1">Included in every account</h3>
              <p className="text-xs text-fg-base mb-5">
                All features available during beta. No credit card, no API key needed.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SHARED_FEATURES.map((f) => (
                  <div key={f} className="flex items-start gap-2 text-sm text-fg-base">
                    <Check className="h-4 w-4 text-inari-accent shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Enterprise note */}
            <div className="mt-6 rounded-xl border border-inari-border bg-inari-card p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Building2 className="h-5 w-5 text-fg-base mt-0.5" aria-hidden="true" />
                <div>
                  <h3 className="text-sm font-semibold text-fg-strong">Enterprise</h3>
                  <p className="text-xs text-fg-base mt-0.5">
                    Need SSO, audit logs, dedicated support, or custom AI quotas? Let&apos;s talk.
                  </p>
                </div>
              </div>
              <a href="mailto:info@jesusbr.com" className="shrink-0">
                <Button variant="outline" className="border-inari-border">
                  Contact sales
                </Button>
              </a>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section aria-labelledby="faq-heading" className="border-t border-inari-border py-20">
          <div className="mx-auto max-w-3xl px-6">
            <h2 id="faq-heading" className="text-2xl font-bold text-fg-strong mb-10 text-center">
              Frequently asked questions
            </h2>
            <div className="space-y-8">
              {FAQS.map((item) => (
                <div key={item.q}>
                  <h3 className="text-sm font-semibold text-fg-strong">{item.q}</h3>
                  <p className="mt-1.5 text-sm text-fg-base leading-relaxed">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Footer — matches landing page */}
      <footer className="border-t border-inari-border py-12">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <Image
                src="/logo-inari/favicon-96x96.png"
                alt=""
                width={24}
                height={24}
              />
              <span className="font-mono text-sm text-fg-base">
                inariwatch · built in MX
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fg-base">
              <Link href="/docs"    className="hover:text-fg-strong transition-colors">Docs</Link>
              <Link href="/pricing" className="hover:text-fg-strong transition-colors">Pricing</Link>
              <Link href="/download" className="hover:text-fg-strong transition-colors">Mobile</Link>
              <Link href="/trust"   className="hover:text-fg-strong transition-colors">Trust</Link>
              <Link href="/status"  className="hover:text-fg-strong transition-colors">Status</Link>
              <Link href="/blog"    className="hover:text-fg-strong transition-colors">Blog</Link>
              <a
                href="https://github.com/orbita-pos/inariwatch-capture"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-fg-strong transition-colors"
              >
                GitHub
              </a>
              <Link href="/privacy" className="hover:text-fg-strong transition-colors">Privacy</Link>
              <Link href="/terms"   className="hover:text-fg-strong transition-colors">Terms</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
