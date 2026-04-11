import Link from "next/link";
import { ArrowRight, Check, Sparkles, Building2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "../marketing-nav";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — InariWatch",
  description: "Free forever for indie devs. Pro $12/mo for production. Same features, more AI.",
  alternates: { canonical: "https://inariwatch.com/pricing" },
  openGraph: {
    title: "Pricing — InariWatch",
    description: "Free forever for indie devs. Pro $12/mo for production. Same features, more AI.",
    url: "https://inariwatch.com/pricing",
    images: [{ url: "/demo-poster.png", width: 1200, height: 630, alt: "InariWatch pricing" }],
  },
  twitter: { card: "summary_large_image", title: "Pricing — InariWatch", images: ["/demo-poster.png"] },
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
  "Capture SDK + eBPF Agent",
  "Status page automation",
  "Workspace + team invites",
];

const FREE_LIMITS = [
  { feature: "Auto-analyses", limit: "300/mo" },
  { feature: "AI Remediations", limit: "3/mo" },
  { feature: "Ask Inari (chat)", limit: "100 messages/mo" },
  { feature: "PR Predictions", limit: "10/mo" },
  { feature: "AI Postmortems", limit: "5/mo" },
];

const PRO_LIMITS = [
  { feature: "Auto-analyses", limit: "3,000/mo (10x)" },
  { feature: "AI Remediations", limit: "25/mo (8x)" },
  { feature: "Ask Inari (chat)", limit: "500 messages/mo (5x)" },
  { feature: "PR Predictions", limit: "30/mo (3x)" },
  { feature: "AI Postmortems", limit: "50/mo (10x)" },
];

const PRO_EXTRAS = [
  "Email support",
  "Annual billing: $120/year (save $24)",
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav opaque />

      {/* Hero */}
      <section className="relative pt-32 pb-12 sm:pt-40 sm:pb-16">
        <div className="absolute inset-0 bg-radial-fade opacity-30" />
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-fg-strong sm:text-6xl leading-[1.05]">
            Generous free tier.
            <br />
            <span className="text-gradient-accent glow-accent-text">Pro for production.</span>
          </h1>

          <p className="mt-6 text-lg text-fg-base max-w-2xl mx-auto leading-relaxed">
            Same features in both plans — Pro just gives you more AI. No credit card to start.
            Upgrade when you need it. Cancel anytime.
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="grid gap-6 lg:grid-cols-2">

            {/* Free plan */}
            <div className="rounded-2xl border border-inari-border bg-inari-card p-8 flex flex-col">
              <div className="mb-6">
                <h2 className="text-xl font-bold text-fg-strong">Free</h2>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-5xl font-bold text-fg-strong font-mono">$0</span>
                  <span className="text-zinc-500 text-sm">/month forever</span>
                </div>
                <p className="mt-2 text-sm text-zinc-500">For indie devs and side projects.</p>
              </div>

              <div className="mb-6">
                <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Monthly AI quotas
                </p>
                <ul className="space-y-2">
                  {FREE_LIMITS.map((item) => (
                    <li key={item.feature} className="flex items-baseline justify-between text-sm">
                      <span className="text-fg-base">{item.feature}</span>
                      <span className="font-mono text-zinc-400">{item.limit}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mb-8 flex-1">
                <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Everything in Pro, except:
                </p>
                <ul className="space-y-1.5">
                  <li className="flex items-start gap-2 text-sm text-zinc-500">
                    <X className="h-4 w-4 text-zinc-700 shrink-0 mt-0.5" />
                    No email support
                  </li>
                </ul>
              </div>

              <Link href="/register">
                <Button variant="outline" className="w-full py-3 border-inari-border">
                  Start free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            </div>

            {/* Pro plan */}
            <div className="rounded-2xl border-2 border-inari-accent/40 bg-inari-card p-8 flex flex-col relative">
              <div className="absolute -top-3 left-6">
                <span className="bg-inari-accent text-inari-bg text-xs font-mono font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                  Recommended
                </span>
              </div>

              <div className="mb-6">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-inari-accent" />
                  <h2 className="text-xl font-bold text-fg-strong">Pro</h2>
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-5xl font-bold text-fg-strong font-mono">$12</span>
                  <span className="text-zinc-500 text-sm">/month</span>
                </div>
                <p className="mt-2 text-sm text-zinc-500">
                  Or <span className="text-inari-accent font-semibold">$120/year</span> — save $24 (2 months free)
                </p>
              </div>

              <div className="mb-6">
                <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
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
                <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Plus
                </p>
                <ul className="space-y-1.5">
                  {PRO_EXTRAS.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm text-fg-base">
                      <Check className="h-4 w-4 text-inari-accent shrink-0 mt-0.5" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <Link href="/register?plan=pro">
                <Button variant="primary" className="w-full py-3">
                  Upgrade to Pro
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            </div>

          </div>

          {/* Shared features list */}
          <div className="mt-12 rounded-xl border border-inari-border bg-inari-card p-8">
            <h3 className="text-sm font-semibold text-fg-strong mb-1">Same features in both plans</h3>
            <p className="text-xs text-zinc-500 mb-5">
              Free users get the full product. Pro just unlocks more monthly AI usage.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {SHARED_FEATURES.map((f) => (
                <div key={f} className="flex items-start gap-2 text-sm text-fg-base">
                  <Check className="h-4 w-4 text-inari-accent shrink-0 mt-0.5" />
                  <span>{f}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Enterprise note */}
          <div className="mt-6 rounded-xl border border-inari-border bg-inari-card p-6 flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Building2 className="h-5 w-5 text-zinc-500 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-fg-strong">Enterprise</h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Need SSO, audit logs, dedicated support, or custom AI quotas? Let&apos;s talk.
                </p>
              </div>
            </div>
            <a href="mailto:jesus@inariwatch.com" className="shrink-0">
              <Button variant="outline" className="border-inari-border text-fg-base hover:text-fg-strong hover:border-line">
                Contact sales
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-inari-border py-20">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="text-2xl font-bold text-fg-strong mb-10 text-center">Questions</h2>
          <div className="space-y-8">
            <FaqItem
              q="What happens when I hit a quota limit on free?"
              a="Auto-analyses, predictions, and postmortems just stop running silently for the rest of the month — your alerts still come through, just without AI summary. Remediations show an upgrade message. Everything resets day 1 of next month."
            />
            <FaqItem
              q="Why is the free tier so generous?"
              a="Because every user makes the product better. When you fix a bug, that fix is anonymized and added to the Community Fix Network — so the next person with the same bug sees 'X teams fixed this in Y minutes'. More users → more fixes → smarter AI for everyone."
            />
            <FaqItem
              q="Do I need my own AI key?"
              a="No. The free tier uses platform-funded GPT-4o-mini for auto-analyses (we pay). For Pro users, allocations are also platform-funded. You can optionally bring your own key (Claude, OpenAI, Groq, etc.) for unlimited usage."
            />
            <FaqItem
              q="Why $12 — what's the catch?"
              a="No catch. We're a small team, and $12 covers our AI costs + leaves a thin margin. Sentry is $26, Cursor is $20, Datadog is $31/host. We're cheaper because we're focused and don't have a sales team. Pricing might go up later as we add more features."
            />
            <FaqItem
              q="Can I cancel anytime?"
              a="Yes. Cancel from your billing portal — your Pro features stay active until the end of the billing period, then you go back to free. No strings."
            />
            <FaqItem
              q="What's the difference vs Sentry / Datadog / etc.?"
              a="We don't just monitor — we fix. AI auto-diagnoses every alert, runs through 11 safety gates, generates a fix, opens a PR, and waits for CI. None of the legacy tools do this. And the Community Fix Network gets smarter every week."
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-inari-border py-10">
        <div className="mx-auto max-w-6xl px-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="font-mono text-fg-base uppercase tracking-widest text-xs font-semibold">INARIWATCH</span>
          <div className="flex items-center gap-6 text-sm text-zinc-500">
            <Link href="/" className="hover:text-fg-base transition-colors">Home</Link>
            <Link href="/docs" className="hover:text-fg-base transition-colors">Docs</Link>
            <Link href="/trust" className="hover:text-fg-base transition-colors">Trust</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <p className="text-sm font-semibold text-fg-strong">{q}</p>
      <p className="mt-1.5 text-sm text-zinc-500 leading-relaxed">{a}</p>
    </div>
  );
}
