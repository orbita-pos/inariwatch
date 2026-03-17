import Link from "next/link";
import { CheckCircle2, XCircle, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Pricing — InariWatch",
  description: "Simple, transparent pricing. Start free, upgrade when you need 24/7 cloud monitoring.",
};

// ── Comparison data ───────────────────────────────────────────────────────────

const CATEGORIES = [
  {
    label: "Monitoring",
    rows: [
      { feature: "Projects",            free: "2",        pro: "10",          team: "Unlimited" },
      { feature: "Integrations",        free: "3",        pro: "20",          team: "Unlimited" },
      { feature: "Poll interval",       free: "30 min",   pro: "5 min",       team: "5 min" },
      { feature: "24/7 cloud polling",  free: false,      pro: true,          team: true },
      { feature: "Anomaly detection",   free: false,      pro: true,          team: true },
      { feature: "Uptime monitoring",   free: false,      pro: true,          team: true },
    ],
  },
  {
    label: "Alerts & history",
    rows: [
      { feature: "Web dashboard",       free: false,      pro: true,          team: true },
      { feature: "Alert history",       free: "—",        pro: "30 days",     team: "90 days" },
      { feature: "Alert comments",      free: false,      pro: true,          team: true },
      { feature: "Desktop app",         free: false,      pro: true,          team: true },
    ],
  },
  {
    label: "AI features",
    rows: [
      { feature: "Alert analysis",      free: false,      pro: true,          team: true },
      { feature: "AI remediation",      free: false,      pro: true,          team: true },
      { feature: "Post-mortem gen.",    free: false,      pro: true,          team: true },
      { feature: "AI model selection",  free: false,      pro: true,          team: true },
    ],
  },
  {
    label: "Notifications",
    rows: [
      { feature: "Push notifications",  free: false,      pro: true,          team: true },
      { feature: "Telegram",            free: true,       pro: true,          team: true },
      { feature: "Slack",               free: false,      pro: true,          team: true },
      { feature: "Email (smart digest)",free: false,      pro: true,          team: true },
    ],
  },
  {
    label: "Team & enterprise",
    rows: [
      { feature: "Team members",        free: false,      pro: false,         team: true },
      { feature: "Roles & permissions", free: false,      pro: false,         team: true },
      { feature: "Status pages",        free: false,      pro: false,         team: true },
      { feature: "Escalation rules",    free: false,      pro: false,         team: true },
      { feature: "Audit logs",          free: false,      pro: false,         team: true },
      { feature: "Priority support",    free: false,      pro: false,         team: true },
    ],
  },
];

const FAQ = [
  {
    q: "Do I need a credit card to start?",
    a: "No. The CLI is free forever and the web free tier requires no card.",
  },
  {
    q: "What counts as an integration?",
    a: "Each connected service per project counts as one integration — e.g. GitHub + Vercel on one project = 2 integrations.",
  },
  {
    q: "Can I bring my own AI key?",
    a: "Yes. InariWatch supports Claude, OpenAI, Grok, DeepSeek, and Gemini. You connect your own key and keep full control of costs.",
  },
  {
    q: "What happens if I exceed my plan limits?",
    a: "You'll see a clear message before hitting the limit. Existing data is never deleted — you just can't add more until you upgrade.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes, cancel anytime from Settings. Your plan downgrades to Free at the end of the billing period.",
  },
  {
    q: "Is there a free trial for Pro or Team?",
    a: "Yes — both plans start with a 14-day free trial, no card required.",
  },
];

// ── Cell renderer ─────────────────────────────────────────────────────────────

function Cell({ value }: { value: boolean | string }) {
  if (typeof value === "boolean") {
    return value
      ? <CheckCircle2 className="h-4 w-4 text-inari-accent mx-auto" />
      : <XCircle className="h-4 w-4 text-zinc-800 mx-auto" />;
  }
  if (value === "—") return <Minus className="h-4 w-4 text-zinc-700 mx-auto" />;
  return <span className="text-sm text-zinc-300 font-medium">{value}</span>;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-inari-bg text-white">

      {/* Nav */}
      <nav className="border-b border-inari-border px-6 py-4">
        <div className="mx-auto max-w-6xl flex items-center justify-between">
          <Link href="/" className="font-mono text-xs font-semibold uppercase tracking-widest text-inari-accent">
            INARIWATCH
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-sm text-zinc-400 hover:text-white transition-colors">Sign in</Link>
            <Link href="/register">
              <Button variant="primary" size="sm">Get started</Button>
            </Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-20">

        {/* Header */}
        <div className="text-center mb-16">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Pricing</p>
          <h1 className="text-4xl font-bold sm:text-5xl">Simple, honest pricing</h1>
          <p className="mt-4 text-lg text-zinc-400 max-w-xl mx-auto">
            Start free with the CLI. Upgrade to cloud when you need 24/7 monitoring.
          </p>
        </div>

        {/* Plan cards */}
        <div className="grid gap-6 lg:grid-cols-3 mb-20">

          {/* Free / Local */}
          <div className="rounded-2xl border border-inari-border bg-inari-card p-8">
            <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Local</p>
            <div className="mt-2 flex items-end gap-1">
              <span className="text-4xl font-bold text-white">Free</span>
              <span className="pb-1 text-zinc-500 text-sm">forever</span>
            </div>
            <p className="mt-2 text-sm text-zinc-500">CLI runs on your machine. Data stays local.</p>
            <a href="#" className="mt-6 block">
              <Button variant="outline" className="w-full">Install CLI</Button>
            </a>
            <ul className="mt-8 space-y-3">
              {["Open source Rust CLI", "GitHub, Vercel, Sentry integrations", "Telegram notifications", "AI correlation (BYOK)", "Works while laptop is on"].map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-inari-accent" />
                  {f}
                </li>
              ))}
              {["Web dashboard", "24/7 monitoring"].map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-700 line-through">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-800" />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Pro */}
          <div className="relative rounded-2xl border border-inari-accent/40 bg-inari-accent-dim p-8 shadow-[0_0_50px_rgba(124,58,237,0.10)]">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="rounded-full bg-inari-accent px-3 py-1 text-xs font-semibold text-white shadow-[0_0_12px_rgba(124,58,237,0.4)]">
                Most popular
              </span>
            </div>
            <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Pro</p>
            <div className="mt-2 flex items-end gap-1">
              <span className="text-4xl font-bold text-white">$9</span>
              <span className="pb-1 text-zinc-500 text-sm">/month</span>
            </div>
            <p className="mt-2 text-sm text-zinc-500">For individual developers who need 24/7 cloud coverage.</p>
            <Link href="/register" className="mt-6 block">
              <Button variant="primary" className="w-full">Start 14-day free trial</Button>
            </Link>
            <ul className="mt-8 space-y-3">
              {[
                "Everything in Local",
                "24/7 cloud monitoring",
                "5-min polling (real-time)",
                "Up to 10 projects",
                "20 integrations",
                "Web dashboard + 30-day history",
                "AI analysis, remediation & post-mortems",
                "Anomaly detection",
                "Telegram, Slack, Email & Push",
                "Desktop app",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-inari-accent" />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Team */}
          <div className="rounded-2xl border border-inari-border bg-inari-card p-8">
            <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Team</p>
            <div className="mt-2 flex items-end gap-1">
              <span className="text-4xl font-bold text-white">$19</span>
              <span className="pb-1 text-zinc-500 text-sm">/month</span>
            </div>
            <p className="mt-2 text-sm text-zinc-500">For teams monitoring multiple projects together.</p>
            <Link href="/register?plan=team" className="mt-6 block">
              <Button variant="outline" className="w-full">Start 14-day free trial</Button>
            </Link>
            <ul className="mt-8 space-y-3">
              {[
                "Everything in Pro",
                "Unlimited projects",
                "Unlimited integrations",
                "90-day alert history",
                "Team members + roles",
                "Status pages",
                "Escalation rules",
                "Audit logs",
                "Priority support",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-inari-accent" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Comparison table */}
        <div className="mb-20">
          <h2 className="text-2xl font-bold mb-8 text-center">Full comparison</h2>
          <div className="rounded-2xl border border-inari-border overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-4 border-b border-inari-border bg-inari-card">
              <div className="p-4" />
              {["Local", "Pro — $9/mo", "Team — $19/mo"].map((h, i) => (
                <div key={h} className={`p-4 text-center text-sm font-semibold ${i === 1 ? "text-inari-accent" : "text-zinc-300"}`}>
                  {h}
                </div>
              ))}
            </div>

            {CATEGORIES.map((cat) => (
              <div key={cat.label}>
                {/* Category label */}
                <div className="grid grid-cols-4 border-b border-inari-border bg-[#0a0a0c]">
                  <div className="px-4 py-2.5 col-span-4 text-xs font-mono text-zinc-600 uppercase tracking-widest">
                    {cat.label}
                  </div>
                </div>
                {/* Rows */}
                {cat.rows.map((row, idx) => (
                  <div
                    key={row.feature}
                    className={`grid grid-cols-4 border-b border-inari-border last:border-0 ${idx % 2 === 0 ? "bg-inari-bg" : "bg-inari-card/50"}`}
                  >
                    <div className="px-4 py-3 text-sm text-zinc-400">{row.feature}</div>
                    <div className="px-4 py-3 flex items-center justify-center"><Cell value={row.free} /></div>
                    <div className="px-4 py-3 flex items-center justify-center border-x border-inari-border/50"><Cell value={row.pro} /></div>
                    <div className="px-4 py-3 flex items-center justify-center"><Cell value={row.team} /></div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* vs competitors */}
        <div className="mb-20 rounded-2xl border border-inari-border bg-inari-card p-8">
          <h2 className="text-xl font-bold mb-6">How we compare</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-inari-border">
                  <th className="text-left py-3 text-zinc-500 font-medium">Tool</th>
                  <th className="text-center py-3 text-zinc-500 font-medium">Starting price</th>
                  <th className="text-center py-3 text-zinc-500 font-medium">AI features</th>
                  <th className="text-center py-3 text-zinc-500 font-medium">BYOK AI</th>
                  <th className="text-center py-3 text-zinc-500 font-medium">Open source CLI</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: "InariWatch",  price: "$9/mo",  ai: true,  byok: true,  cli: true,  highlight: true },
                  { name: "Datadog",     price: "$15/host", ai: true, byok: false, cli: false },
                  { name: "Sentry",      price: "$26/mo", ai: true,  byok: false, cli: false },
                  { name: "PagerDuty",   price: "$21/user", ai: false, byok: false, cli: false },
                  { name: "Betterstack", price: "$24/mo", ai: false, byok: false, cli: false },
                  { name: "OpsGenie",   price: "$9/user", ai: false, byok: false, cli: false },
                ].map((row) => (
                  <tr key={row.name} className={`border-b border-inari-border last:border-0 ${row.highlight ? "text-white" : "text-zinc-400"}`}>
                    <td className={`py-3 font-medium ${row.highlight ? "text-inari-accent" : ""}`}>{row.name}</td>
                    <td className="py-3 text-center">{row.price}</td>
                    <td className="py-3 text-center">{row.ai ? <CheckCircle2 className="h-4 w-4 text-inari-accent mx-auto" /> : <XCircle className="h-4 w-4 text-zinc-700 mx-auto" />}</td>
                    <td className="py-3 text-center">{row.byok ? <CheckCircle2 className="h-4 w-4 text-inari-accent mx-auto" /> : <XCircle className="h-4 w-4 text-zinc-700 mx-auto" />}</td>
                    <td className="py-3 text-center">{row.cli ? <CheckCircle2 className="h-4 w-4 text-inari-accent mx-auto" /> : <XCircle className="h-4 w-4 text-zinc-700 mx-auto" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* FAQ */}
        <div className="mb-20">
          <h2 className="text-2xl font-bold mb-8 text-center">Frequently asked questions</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {FAQ.map((item) => (
              <div key={item.q} className="rounded-xl border border-inari-border bg-inari-card p-6">
                <p className="font-semibold text-white mb-2">{item.q}</p>
                <p className="text-sm text-zinc-400 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="text-center rounded-2xl border border-inari-accent/20 bg-inari-accent-dim p-12">
          <h2 className="text-2xl font-bold mb-2">Ready to stop flying blind?</h2>
          <p className="text-zinc-400 mb-8">Start with the free CLI or jump straight to cloud monitoring.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/register">
              <Button variant="primary" size="lg">Start free trial</Button>
            </Link>
            <Link href="/">
              <Button variant="outline" size="lg">See how it works</Button>
            </Link>
          </div>
          <p className="mt-4 text-xs text-zinc-600">No credit card required · Cancel anytime</p>
        </div>

      </div>

      {/* Footer */}
      <footer className="border-t border-inari-border py-10">
        <div className="mx-auto max-w-6xl px-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="font-mono text-zinc-400 uppercase tracking-widest text-xs font-semibold">INARIWATCH</span>
          <div className="flex items-center gap-6 text-sm text-zinc-600">
            <Link href="/" className="hover:text-zinc-400 transition-colors">Home</Link>
            <Link href="/login" className="hover:text-zinc-400 transition-colors">Sign in</Link>
            <Link href="/register" className="hover:text-zinc-400 transition-colors">Get started</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
