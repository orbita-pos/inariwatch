import Link from "next/link";
import { ArrowRight, Check, Zap, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "../marketing-nav";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — InariWatch",
  description: "InariWatch is free during beta. Full platform access, no credit card required.",
  alternates: { canonical: "https://inariwatch.com/pricing" },
  openGraph: {
    title: "Pricing — InariWatch",
    description: "InariWatch is free during beta. Full platform access, no credit card required.",
    url: "https://inariwatch.com/pricing",
    images: [{ url: "/demo-poster.png", width: 1200, height: 630, alt: "InariWatch pricing" }],
  },
  twitter: { card: "summary_large_image", title: "Pricing — InariWatch", images: ["/demo-poster.png"] },
};

const FREE_FEATURES = [
  "Unlimited alerts",
  "AI auto-analysis on every alert",
  "AI remediation pipeline (BYOK)",
  "Staging verification (ephemeral environments)",
  "11 safety gates + trust levels",
  "Slack bot (14 commands)",
  "Telegram bot (15 commands)",
  "VS Code extension",
  "GitHub Action (PR risk assessment)",
  "MCP server (25 tools)",
  "On-call scheduling + escalation",
  "Community Fix Network",
  "Capture SDK (@inariwatch/capture)",
  "Uptime monitoring + auto-heal",
  "Status page automation",
  "Workspace + team invites",
  "Mobile + desktop apps",
];

const ENTERPRISE_FEATURES = [
  "Everything in Free",
  "Priority support",
  "Custom integrations",
  "SSO / SAML",
  "SLA guarantees",
  "Dedicated infrastructure",
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav opaque />

      {/* Hero */}
      <section className="relative pt-32 pb-16 sm:pt-40 sm:pb-20">
        <div className="absolute inset-0 bg-radial-fade opacity-30" />
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-4 py-1.5">
            <Zap className="h-3.5 w-3.5 text-inari-accent" />
            <span className="text-xs font-mono text-inari-accent tracking-wide">BETA</span>
          </div>

          <h1 className="text-4xl font-bold tracking-tight text-fg-strong sm:text-6xl leading-[1.05]">
            Free while we build
            <br />
            <span className="text-gradient-accent glow-accent-text">the future of monitoring.</span>
          </h1>

          <p className="mt-6 text-lg text-fg-base max-w-2xl mx-auto leading-relaxed">
            InariWatch is in beta. Full platform access, no credit card, no limits.
            Help us shape the product and you&apos;ll be the first to know when plans launch.
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="pb-24">
        <div className="mx-auto max-w-5xl px-6">
          <div className="grid gap-6 lg:grid-cols-2">

            {/* Free plan */}
            <div className="rounded-2xl border-2 border-inari-accent/40 bg-inari-card p-8 relative">
              <div className="absolute -top-3 left-6">
                <span className="bg-inari-accent text-inari-bg text-xs font-mono font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                  Current
                </span>
              </div>

              <div className="mb-6">
                <h2 className="text-xl font-bold text-fg-strong">Free</h2>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-5xl font-bold text-fg-strong font-mono">$0</span>
                  <span className="text-zinc-500 text-sm">/month</span>
                </div>
                <p className="mt-2 text-sm text-zinc-500">Full platform. No strings attached.</p>
              </div>

              <ul className="space-y-3 mb-8">
                {FREE_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check className="h-4 w-4 text-inari-accent shrink-0 mt-0.5" />
                    <span className="text-sm text-fg-base">{f}</span>
                  </li>
                ))}
              </ul>

              <Link href="/register">
                <Button variant="primary" className="w-full py-3">
                  Start free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            </div>

            {/* Enterprise */}
            <div className="rounded-2xl border border-inari-border bg-inari-card p-8 flex flex-col">
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <Building2 className="h-5 w-5 text-zinc-500" />
                  <h2 className="text-xl font-bold text-fg-strong">Enterprise</h2>
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-fg-strong font-mono">Custom</span>
                </div>
                <p className="mt-2 text-sm text-zinc-500">For teams that need more. Coming soon.</p>
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {ENTERPRISE_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check className="h-4 w-4 text-zinc-500 shrink-0 mt-0.5" />
                    <span className="text-sm text-fg-base">{f}</span>
                  </li>
                ))}
              </ul>

              <a href="mailto:jesus@inariwatch.com">
                <Button
                  variant="outline"
                  className="w-full py-3 border-inari-border text-fg-base hover:text-fg-strong hover:border-line"
                >
                  Contact us
                </Button>
              </a>
            </div>

          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-inari-border py-20">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="text-xl font-bold text-fg-strong mb-10 text-center">Questions</h2>
          <div className="space-y-8">
            <FaqItem
              q="Why is it free?"
              a="InariWatch is in beta. We're focused on building the best AI monitoring platform, not billing. Free access lets us learn from real usage and ship faster."
            />
            <FaqItem
              q="Will it always be free?"
              a="The core platform will always have a generous free tier. Paid plans will be introduced for teams that need advanced features like SSO, SLA guarantees, and dedicated infrastructure."
            />
            <FaqItem
              q="Do I need my own AI key?"
              a="No. Every alert gets free AI analysis powered by the platform. For advanced features like remediation and Ask Inari chat, you can bring your own key (Claude, OpenAI, Groq, Grok, DeepSeek, or Gemini)."
            />
            <FaqItem
              q="What happens to my data if pricing changes?"
              a="Your data is yours. We'll give at least 90 days notice before any pricing changes, and you'll always be able to export your data."
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
