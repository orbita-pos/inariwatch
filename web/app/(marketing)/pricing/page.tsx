import Link from "next/link";
import { CheckCircle2, XCircle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export const metadata = {
  title: "Pricing — InariWatch",
  description: "The only monitoring tool that fixes your code while you sleep. Free CLI, or full autonomous incident response for $9/mo.",
};

// ── Feature table data ─────────────────────────────────────────────────────────

const COMPARISON = [
  {
    category: "Monitoring",
    rows: [
      { feature: "Projects",              cli: "∞ local",   pro: "5",         team: "20" },
      { feature: "Integrations",          cli: "∞ local",   pro: "10",        team: "40" },
      { feature: "GitHub CI / PRs",       cli: true,        pro: true,        team: true },
      { feature: "Vercel deployments",    cli: true,        pro: true,        team: true },
      { feature: "Sentry issues",         cli: true,        pro: true,        team: true },
      { feature: "Uptime / HTTP",         cli: false,       pro: true,        team: true },
      { feature: "PostgreSQL health",     cli: false,       pro: true,        team: true },
      { feature: "npm / Cargo audit",     cli: false,       pro: true,        team: true },
      { feature: "Poll interval",         cli: "60s (local)", pro: "1 min", team: "1 min" },
      { feature: "Real-time webhooks",    cli: false,       pro: true,        team: true },
      { feature: "24/7 cloud polling",    cli: false,       pro: true,        team: true },
      { feature: "Anomaly detection",     cli: false,       pro: true,        team: true },
    ],
  },
  {
    category: "AI — the part no one else has",
    rows: [
      { feature: "AI alert correlation",      cli: "BYOK",  pro: "BYOK",  team: "BYOK" },
      { feature: "Auto root-cause analysis",  cli: false,   pro: "BYOK",  team: "BYOK" },
      { feature: "AI code remediation + PR",  cli: false,   pro: "BYOK",  team: "BYOK" },
      { feature: "CI retry loop (auto-fix)",  cli: false,   pro: "BYOK",  team: "BYOK" },
      { feature: "Pre-deploy risk on PRs",    cli: false,   pro: "BYOK",  team: "BYOK" },
      { feature: "Post-mortem generation",    cli: false,   pro: "BYOK",  team: "BYOK" },
      { feature: "Ask Inari (AI copilot)",    cli: false,   pro: "BYOK",  team: "BYOK" },
      { feature: "5 AI providers (your key)", cli: "BYOK",  pro: "BYOK",  team: "BYOK" },
    ],
  },
  {
    category: "Alerts & history",
    rows: [
      { feature: "Web dashboard",             cli: false,   pro: true,    team: true },
      { feature: "Alert history",             cli: "Local", pro: "30 days", team: "30 days" },
      { feature: "Vercel instant rollback",   cli: false,   pro: true,    team: true },
      { feature: "Alert export (CSV)",        cli: false,   pro: true,    team: true },
      { feature: "Analytics & trends",        cli: false,   pro: true,    team: true },
      { feature: "Alert comments",            cli: false,   pro: true,    team: true },
    ],
  },
  {
    category: "Notifications",
    rows: [
      { feature: "Telegram",             cli: true,    pro: true,   team: true },
      { feature: "Email (smart digest)", cli: false,   pro: true,   team: true },
      { feature: "Slack",                cli: false,   pro: true,   team: true },
      { feature: "Push notifications",   cli: false,   pro: true,   team: true },
      { feature: "Escalation rules",     cli: false,   pro: true,   team: true },
      { feature: "Outgoing webhooks",    cli: false,   pro: true,   team: true },
    ],
  },
  {
    category: "Team & access",
    rows: [
      { feature: "Desktop app",          cli: false,   pro: true,  team: true },
      { feature: "Team workspaces",      cli: false,   pro: false, team: true },
      { feature: "Member invites",       cli: false,   pro: false, team: "Up to 5 free" },
      { feature: "Plan Inheritance",     cli: false,   pro: false, team: true },
      { feature: "Status pages",         cli: false,   pro: true,  team: true },
      { feature: "Audit log",            cli: false,   pro: false, team: true },
      { feature: "2FA",                  cli: false,   pro: true,  team: true },
    ],
  },
];

const FAQ = [
  {
    q: "Vercel and GitHub already send me emails. Why pay for this?",
    a: "They tell you what broke. InariWatch reads your code, writes the fix, waits for CI, and opens the PR. You approve or reject — that's the only step you do manually.",
  },
  {
    q: "What does 'AI code remediation' actually mean?",
    a: "When an alert fires, InariWatch connects to your repo, reads the relevant files, generates a code fix, pushes a branch, monitors CI, and retries with the CI failure logs if it doesn't pass. When CI is green, it opens a PR. You get a notification with a link.",
  },
  {
    q: "Do I need to give it my AI API key?",
    a: "Yes — you bring your own key (Claude, OpenAI, Grok, DeepSeek, or Gemini). You control costs and your code never goes through our servers for AI processing.",
  },
  {
    q: "What's the difference between the CLI and the web product?",
    a: "The CLI runs on your machine — it monitors while your laptop is on and can send Telegram alerts with AI correlation. The web product runs 24/7 in the cloud, adds the dashboard, and unlocks the full AI remediation pipeline.",
  },
  {
    q: "What if the AI-generated fix breaks something?",
    a: "The fix only lands in a PR — you approve before it merges. The retry loop means it only creates the PR after CI passes, so you get human review on working code, not broken experiments.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Cancel from Settings. You stay on Pro until the end of the billing period, then drop to Free. Your data stays intact.",
  },
];

// ── Cell renderer ──────────────────────────────────────────────────────────────

function Cell({ value, highlight }: { value: boolean | string; highlight?: boolean }) {
  if (typeof value === "boolean") {
    return value
      ? <CheckCircle2 className={`h-4 w-4 mx-auto ${highlight ? "text-inari-accent" : "text-inari-accent/70"}`} />
      : <XCircle className="h-4 w-4 text-line-medium mx-auto opacity-40" />;
  }
  return (
    <span className={`text-sm font-medium ${highlight ? "text-inari-accent" : "text-fg-base"}`}>
      {value}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-inari-bg text-fg-strong">

      {/* Nav */}
      <nav className="border-b border-inari-border px-6 py-4">
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <Link href="/" className="font-mono text-xs font-semibold uppercase tracking-widest text-inari-accent">
            INARIWATCH
          </Link>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <Link href="/login" className="text-sm text-fg-base hover:text-fg-strong transition-colors">
              Sign in
            </Link>
            <Link href="/register">
              <Button variant="primary" size="sm">Get started free</Button>
            </Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-20">

        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <div className="text-center mb-6">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-4">Pricing</p>
          <h1 className="text-4xl font-bold sm:text-5xl leading-tight">
            Your CI broke at 3am.
            <br />
            <span className="text-inari-accent">The fix was already merged by 3:04.</span>
          </h1>
          <p className="mt-5 text-lg text-fg-base max-w-2xl mx-auto">
            InariWatch monitors GitHub, Vercel, and Sentry — then goes further.
            When something breaks, it reads your code, writes the fix, runs CI, and opens a PR.
            You just approve.
          </p>
        </div>

        {/* ── What the AI actually does ─────────────────────────────────── */}
        <div className="mb-20 mt-14 rounded-2xl border border-inari-border bg-inari-card overflow-hidden">
          <div className="px-6 py-4 border-b border-inari-border">
            <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">What happens when an alert fires (Pro)</p>
          </div>
          <div className="grid sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-inari-border">
            {[
              { n: "01", title: "Alert fires",       desc: "CI fails, deploy errors, Sentry regression — InariWatch catches it in real time." },
              { n: "02", title: "AI reads code",     desc: "Connects to your repo, fetches the relevant files, diagnoses root cause." },
              { n: "03", title: "Fix generated",     desc: "AI writes the code change with a plain-English explanation of what it did." },
              { n: "04", title: "CI validation",     desc: "Pushes to a branch, monitors CI. If it fails, reads logs and retries up to 3×." },
              { n: "05", title: "PR opened",         desc: "When CI passes, opens a PR. You get a notification. One click to approve." },
            ].map((step) => (
              <div key={step.n} className="flex flex-col gap-2 p-5">
                <span className="font-mono text-[11px] text-inari-accent">{step.n}</span>
                <p className="text-sm font-semibold text-fg-strong">{step.title}</p>
                <p className="text-xs text-zinc-500 leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Plan cards ────────────────────────────────────────────────── */}
        <div className="grid gap-5 md:grid-cols-3 mb-20">

          {/* CLI */}
          <div className="rounded-2xl border border-inari-border bg-inari-card p-7 flex flex-col">
            <div>
              <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Local CLI</p>
              <div className="mt-2 flex items-end gap-1">
                <span className="text-3xl font-bold text-fg-strong">Free</span>
                <span className="pb-0.5 text-zinc-500 text-sm">forever</span>
              </div>
              <p className="mt-2 text-sm text-zinc-500">
                Open source Rust CLI. Runs on your machine, data stays local. No account required.
              </p>
            </div>
            <div className="mt-6">
              <a href="#">
                <Button variant="outline" className="w-full">Install CLI</Button>
              </a>
            </div>
            <ul className="mt-7 space-y-2.5 flex-1">
              {[
                "GitHub, Vercel, Sentry monitoring",
                "Unlimited local projects",
                "Telegram alerts",
                "AI correlation (BYOK)",
                "Local SQLite — no cloud",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-fg-base">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-inari-accent/70" />
                  {f}
                </li>
              ))}
              {[
                "Works only while laptop is on",
                "No web dashboard or AI remediation",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-zinc-600">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-30" />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Pro */}
          <div className="rounded-2xl border border-inari-border bg-inari-card p-7 flex flex-col">
            <div>
              <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Pro</p>
              <div className="mt-2 flex items-end gap-1">
                <span className="text-3xl font-bold text-fg-strong">$4.99</span>
                <span className="pb-0.5 text-zinc-500 text-sm">/month</span>
              </div>
              <p className="mt-2 text-sm text-zinc-500">
                Full autonomous incident response for solo developers. Monitors 24/7 in the cloud.
              </p>
            </div>
            <div className="mt-6">
              <Link href="/register">
                <Button variant="outline" className="w-full">Get started</Button>
              </Link>
            </div>
            <ul className="mt-7 space-y-2.5 flex-1">
              {[
                "AI code remediation + PR (BYOK)",
                "5 projects, 10 integrations",
                "1-min cloud polling",
                "Slack, Email & Push alerts",
                "30-day alert history",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-fg-base">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-inari-accent/70" />
                  {f}
                </li>
              ))}
              {[
                "No team workspaces",
                "No team invites",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-zinc-600">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-30" />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Team */}
          <div className="relative rounded-2xl border border-inari-accent/40 bg-inari-accent-dim p-7 flex flex-col shadow-[0_0_60px_rgba(124,58,237,0.12)]">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="rounded-full bg-inari-accent px-3 py-1 text-xs font-semibold text-white">
                Best for agencies
              </span>
            </div>
            <div>
              <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Team</p>
              <div className="mt-2 flex items-end gap-1">
                <span className="text-3xl font-bold text-fg-strong">$9.99</span>
                <span className="pb-0.5 text-zinc-500 text-sm">/month</span>
              </div>
              <p className="mt-2 text-sm text-zinc-500">
                Workspaces and inherited benefits. Include your team in the loop.
              </p>
            </div>
            <div className="mt-6">
              <Link href="/register">
                <Button variant="primary" className="w-full">Start 14-day free trial</Button>
              </Link>
              <p className="mt-2 text-center text-[11px] text-zinc-600">No card required</p>
            </div>
            <ul className="mt-7 space-y-2.5 flex-1">
              {[
                { text: "AI writes & pushes code fixes", bold: true },
                { text: "Team Workspaces included", bold: true },
                { text: "Inherited 1-min polling per workspace", bold: true },
                { text: "Up to 5 members free", bold: false },
                { text: "20 projects, 40 integrations", bold: false },
                { text: "30-day alert history + analytics", bold: false },
                { text: "All notifications (Slack, Email, Push)", bold: false },
                { text: "Pre-deploy risk assessment on PRs", bold: false },
                { text: "Anomaly detection (proactive alerts)", bold: false },
                { text: "Ask Inari — AI chat with your data", bold: false },
                { text: "Status pages & audit log", bold: false },
                { text: "Desktop app with OS notifications", bold: false },
              ].map((f) => (
                <li key={f.text} className="flex items-start gap-2 text-sm text-fg-base">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-inari-accent" />
                  <span className={f.bold ? "font-medium text-fg-strong" : ""}>{f.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* ── Who each plan is for ───────────────────────────────────────── */}
        <div className="mb-20 grid gap-4 md:grid-cols-3">
          {[
            {
              plan: "CLI",
              for: "Side projects, hobbyists",
              why: "You want monitoring without a subscription. You're online when you're working and Telegram is enough.",
            },
            {
              plan: "Pro",
              for: "Solo developers",
              why: "You want incidents handled automatically in the Cloud. Wake up to a PR, not a 3am page, and use your own AI api keys.",
            },
            {
              plan: "Team",
              for: "Startups & Agencies",
              why: "You want your team to be in the loop. Create workspaces, invite them, and everyone inherits your fast 1-min polling speeds.",
              highlight: true,
            },
          ].map((item) => (
            <div
              key={item.plan}
              className={`rounded-xl border p-5 ${item.highlight ? "border-inari-accent/30 bg-inari-accent-dim" : "border-inari-border bg-inari-card"}`}
            >
              <p className={`text-xs font-mono uppercase tracking-widest mb-2 ${item.highlight ? "text-inari-accent" : "text-zinc-500"}`}>
                {item.plan} — {item.for}
              </p>
              <p className="text-sm text-fg-base leading-relaxed">{item.why}</p>
            </div>
          ))}
        </div>

        {/* ── Comparison table ──────────────────────────────────────────── */}
        <div className="mb-20">
          <h2 className="text-2xl font-bold mb-2 text-center">Full comparison</h2>
          <p className="text-center text-sm text-zinc-500 mb-8">BYOK = Bring Your Own Key. AI features use your API key directly.</p>
          <div className="rounded-2xl border border-inari-border overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-4 border-b border-inari-border bg-inari-card">
              <div className="p-4" />
              {[
                { label: "CLI",      sub: "Free forever" },
                { label: "Pro",      sub: "$4.99 / mo" },
                { label: "Team",     sub: "$9.99 / mo", accent: true },
              ].map((h) => (
                <div key={h.label} className={`p-4 text-center ${h.accent ? "text-inari-accent" : "text-fg-base"}`}>
                  <p className="text-sm font-semibold">{h.label}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{h.sub}</p>
                </div>
              ))}
            </div>

            {COMPARISON.map((section) => (
              <div key={section.category}>
                {/* Section label */}
                <div className="grid grid-cols-4 border-b border-inari-border bg-surface-inner">
                  <div className="px-4 py-2.5 col-span-4 text-xs font-mono text-zinc-500 uppercase tracking-widest">
                    {section.category}
                  </div>
                </div>
                {/* Rows */}
                {section.rows.map((row, idx) => (
                  <div
                    key={row.feature}
                    className={`grid grid-cols-4 border-b border-inari-border last:border-0 ${idx % 2 === 0 ? "bg-inari-bg" : "bg-inari-card/40"}`}
                  >
                    <div className="px-4 py-3 text-sm text-fg-base">{row.feature}</div>
                    <div className="px-4 py-3 flex items-center justify-center">
                      <Cell value={row.cli} />
                    </div>
                    <div className="px-4 py-3 flex items-center justify-center">
                      <Cell value={row.pro} />
                    </div>
                    <div className="px-4 py-3 flex items-center justify-center border-l border-inari-border/30">
                      <Cell value={row.team} highlight />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* ── FAQ ───────────────────────────────────────────────────────── */}
        <div className="mb-20">
          <h2 className="text-2xl font-bold mb-8 text-center">Questions</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {FAQ.map((item) => (
              <div key={item.q} className="rounded-xl border border-inari-border bg-inari-card p-6">
                <p className="font-semibold text-fg-strong mb-2">{item.q}</p>
                <p className="text-sm text-fg-base leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── CTA ───────────────────────────────────────────────────────── */}
        <div className="text-center rounded-2xl border border-inari-accent/20 bg-inari-accent-dim p-12">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Get started</p>
          <h2 className="text-2xl font-bold mb-2">Next time something breaks, you won't have to fix it.</h2>
          <p className="text-fg-base mb-8 max-w-lg mx-auto">
            Start with the free CLI or the web dashboard. Upgrade to Pro when you want incidents handled for you.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/register">
              <Button variant="primary" size="lg">
                Start free trial
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link href="/">
              <Button variant="outline" size="lg">See how it works</Button>
            </Link>
          </div>
          <p className="mt-4 text-xs text-zinc-500">14-day trial · No credit card · Cancel anytime</p>
        </div>

      </div>

      {/* Footer */}
      <footer className="border-t border-inari-border py-10">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="font-mono text-zinc-500 uppercase tracking-widest text-xs font-semibold">
            INARIWATCH
          </span>
          <div className="flex items-center gap-6 text-sm text-zinc-500">
            <Link href="/" className="hover:text-fg-base transition-colors">Home</Link>
            <Link href="/login" className="hover:text-fg-base transition-colors">Sign in</Link>
            <Link href="/register" className="hover:text-fg-base transition-colors">Get started</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
