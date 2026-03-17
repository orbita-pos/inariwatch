import Link from "next/link";
import Image from "next/image";
import {
  Github,
  Terminal,
  Zap,
  Activity,
  CheckCircle2,
  Brain,
  MessageSquare,
  TrendingUp,
  GitPullRequest,
  FileText,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "./copy-button";

// ── Nav ───────────────────────────────────────────────────────────────────────

function Nav() {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 border-b border-inari-border/50 bg-inari-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/logo-inari/favicon-96x96.png"
            alt="InariWatch"
            width={36}
            height={36}
            className="shrink-0"
          />
          <span className="font-mono font-bold text-white uppercase tracking-widest text-sm">INARIWATCH</span>
        </Link>

        <div className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
          <Link href="#integrations"  className="hover:text-zinc-100 transition-colors">Integrations</Link>
          <Link href="#ai"            className="hover:text-zinc-100 transition-colors">AI features</Link>
          <Link href="#pricing"       className="hover:text-zinc-100 transition-colors">Pricing</Link>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="#"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <Github className="h-4 w-4" />
            <span className="hidden sm:inline">GitHub</span>
          </Link>
          <Link href="/login">
            <Button variant="outline" size="sm">Sign in</Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden min-h-[680px] lg:min-h-[780px] flex items-center">
      {/* Fox hero image — full bleed, responsive source */}
      <div className="absolute inset-0">
        <Image
          src="/hero-fox-2k.png"
          alt="InariWatch — fox guardian at the shrine"
          fill
          className="object-cover object-center hidden sm:block"
          priority
          quality={90}
        />
        <Image
          src="/hero-fox-2k-mobile.png"
          alt="InariWatch — fox guardian at the shrine"
          fill
          className="object-cover object-top sm:hidden"
          priority
          quality={90}
        />
        {/* Left gradient: dark → transparent so text is readable, fox stays visible */}
        <div className="absolute inset-0 bg-gradient-to-r from-inari-bg via-inari-bg/90 via-[52%] to-inari-bg/10" />
        {/* Bottom fade into the next section */}
        <div className="absolute bottom-0 inset-x-0 h-32 bg-gradient-to-t from-inari-bg to-transparent" />
        {/* Top fade for nav readability */}
        <div className="absolute top-0 inset-x-0 h-24 bg-gradient-to-b from-inari-bg/60 to-transparent" />
      </div>

      {/* Content — left half */}
      <div className="relative w-full pt-32 pb-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="max-w-xl">
            {/* Headline */}
            <h1 className="text-5xl font-bold tracking-tight text-white sm:text-6xl lg:text-7xl leading-[1.05]">
              Your codebase,
              <br />
              <span className="text-gradient-accent glow-accent-text">watched.</span>
            </h1>

            <p className="mt-6 text-lg text-zinc-400 leading-relaxed max-w-md">
              InariWatch monitors GitHub, Vercel, Sentry, and more.
              When something breaks, you get{" "}
              <span className="text-zinc-200">one smart alert</span> — not six.
            </p>

            {/* CTAs */}
            <div className="mt-10 flex flex-col gap-3 max-w-md">
              {/* Cloud — primary */}
              <Link href="/register" className="w-full">
                <Button variant="primary" className="w-full py-3 text-base">
                  Get started free — no install required
                </Button>
              </Link>

              {/* CLI — equally prominent */}
              <div className="group flex w-full items-center gap-3 rounded-xl border border-inari-border bg-inari-card/90 backdrop-blur-sm px-4 py-3 font-mono text-sm hover:border-zinc-700 transition-colors">
                <span className="text-inari-accent select-none">$</span>
                <span className="flex-1 text-zinc-300">curl -fsSL https://get.inariwatch.com | sh</span>
                <CopyButton text="curl -fsSL https://get.inariwatch.com | sh" />
              </div>
            </div>

            {/* Social proof */}
            <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm text-zinc-500">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                Runs local or 24/7 cloud
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                BYOK — your AI key
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                Single binary, zero deps
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar() {
  const stats = [
    { value: "6",    label: "integrations" },
    { value: "5 min", label: "poll interval" },
    { value: "5",    label: "AI features" },
    { value: "24/7", label: "cloud monitoring" },
  ];

  return (
    <div className="border-y border-inari-border bg-inari-card/40">
      <div className="mx-auto max-w-6xl px-6 py-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <p className="text-2xl font-bold text-white font-mono">{s.value}</p>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Integrations ──────────────────────────────────────────────────────────────
//
// Layout: fox looking right (left) → integration cards (right)
// Fox image prompt:
//   cute chubby pixel art fox with glowing blue eyes, sitting and looking to the right,
//   side profile view, glowing torii gate behind it, pixel cyberpunk atmosphere,
//   dark background #09090b, neon reflections, 32-bit pixel art style, clean pixel grid,
//   composition: fox on the left third looking toward the right, lots of empty dark space
//   on the right, square or 4:3 aspect ratio

function Integrations() {
  const integrations = [
    {
      name: "GitHub",
      alerts: ["Failed CI checks", "Stale & unreviewed PRs", "Pre-deploy risk assessment"],
      status: "live",
    },
    {
      name: "Vercel",
      alerts: ["Failed production deploys", "Failed preview deploys"],
      status: "live",
    },
    {
      name: "Sentry",
      alerts: ["New issues", "Regressions (resolved → reopen)"],
      status: "live",
    },
    {
      name: "Uptime",
      alerts: ["Endpoint downtime", "Slow response time"],
      status: "live",
    },
    {
      name: "PostgreSQL",
      alerts: ["Connection failures", "High connections", "Long-running queries"],
      status: "soon",
    },
    {
      name: "npm / Cargo",
      alerts: ["Critical CVEs", "High-severity vulnerabilities"],
      status: "soon",
    },
  ];

  return (
    <section id="integrations" className="py-24 border-t border-inari-border overflow-hidden">
      <div className="mx-auto max-w-6xl px-6">
        {/* Header */}
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Integrations</p>
          <h2 className="text-3xl font-bold text-white sm:text-4xl max-w-lg">
            Connects to everything in your stack
          </h2>
          <p className="mt-4 text-zinc-400 max-w-md">
            One place for all your alerts. InariWatch polls every 5 minutes and
            surfaces what matters — already correlated.
          </p>
        </div>

        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] items-start">
          {/* Fox image — looking right toward the cards */}
          {/* Replace /hero-fox-2k.png with /hero-fox-integrations.png once generated */}
          <div className="relative rounded-2xl overflow-hidden aspect-square lg:aspect-[3/4] hidden lg:block">
            <Image
              src="/integration.png"
              alt="Inari fox watching your integrations"
              fill
              className="object-cover object-center"
              quality={85}
            />
            {/* Fade right edge into the cards */}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-inari-bg" />
            {/* Bottom fade */}
            <div className="absolute bottom-0 inset-x-0 h-24 bg-gradient-to-t from-inari-bg to-transparent" />
          </div>

          {/* Integration cards */}
          <div className="grid gap-3 sm:grid-cols-2">
            {integrations.map((item) => (
              <div
                key={item.name}
                className={`rounded-xl border bg-inari-card p-5 transition-all ${
                  item.status === "live"
                    ? "border-inari-border hover:border-inari-accent/30 hover:shadow-[0_0_20px_rgba(124,58,237,0.06)]"
                    : "border-inari-border opacity-50"
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-zinc-100">{item.name}</h3>
                  {item.status === "live" ? (
                    <span className="text-xs font-mono text-inari-accent bg-inari-accent-dim px-2 py-0.5 rounded-full border border-inari-accent/20">
                      live
                    </span>
                  ) : (
                    <span className="text-xs font-mono text-zinc-600 bg-zinc-800/60 px-2 py-0.5 rounded-full">
                      soon
                    </span>
                  )}
                </div>
                <ul className="space-y-1">
                  {item.alerts.map((a) => (
                    <li key={a} className="flex items-start gap-2 text-xs text-zinc-500">
                      <span className="mt-0.5 text-inari-accent/60">·</span>
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── AI Features ───────────────────────────────────────────────────────────────

function AIFeatures() {
  const features = [
    {
      icon: <GitPullRequest className="h-5 w-5" />,
      title: "Pre-deploy Risk Assessment",
      body: "AI analyzes every PR diff against your incident history and posts a risk report directly on GitHub before you merge.",
      tag: "GitHub PRs",
    },
    {
      icon: <Wrench className="h-5 w-5" />,
      title: "AI Auto-Remediation",
      body: "When an alert fires, AI diagnoses the root cause, proposes a fix, opens a branch and waits for CI to pass before merging.",
      tag: "Auto-fix",
    },
    {
      icon: <TrendingUp className="h-5 w-5" />,
      title: "Anomaly Detection",
      body: "Detects alert frequency spikes, repeating failure loops, integration degradation, and unusual silence — before they escalate.",
      tag: "Proactive",
    },
    {
      icon: <MessageSquare className="h-5 w-5" />,
      title: "Ask Inari",
      body: "Chat with your live monitoring data. \"What failed this week?\", \"Which integration has the most errors?\" — Inari knows.",
      tag: "Ops chat",
    },
    {
      icon: <Brain className="h-5 w-5" />,
      title: "AI Correlation",
      body: "Groups related alerts from different services into one correlated report with a single root cause and next action.",
      tag: "Smart alerts",
    },
    {
      icon: <FileText className="h-5 w-5" />,
      title: "Auto Post-mortems",
      body: "When an incident resolves, AI automatically generates a full post-mortem: timeline, root cause, impact, and prevention steps.",
      tag: "Incidents",
    },
  ];

  return (
    <section id="ai" className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        {/* Header */}
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">AI-powered</p>
          <h2 className="text-3xl font-bold text-white sm:text-4xl max-w-lg">
            Not just alerts — intelligence
          </h2>
          <p className="mt-4 text-zinc-400 max-w-md">
            Bring your own AI key (Claude or OpenAI). InariWatch uses it to
            turn raw events into decisions.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="group rounded-xl border border-inari-border bg-inari-card p-6 transition-all hover:border-inari-accent/30 hover:shadow-[0_0_24px_rgba(124,58,237,0.07)]"
            >
              <div className="mb-4 flex items-center justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-inari-border bg-inari-bg text-inari-accent group-hover:border-inari-accent/30 transition-colors">
                  {f.icon}
                </div>
                <span className="text-xs font-mono text-zinc-600 bg-zinc-800/50 px-2 py-0.5 rounded-full">
                  {f.tag}
                </span>
              </div>
              <h3 className="font-semibold text-zinc-100 mb-2">{f.title}</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Correlation demo ──────────────────────────────────────────────────────────

function CorrelationDemo() {
  return (
    <section className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Smart alerts</p>
          <h2 className="text-3xl font-bold text-white sm:text-4xl max-w-lg">
            One alert instead of six
          </h2>
          <p className="mt-4 text-zinc-400 max-w-md">
            Every tool fires its own notification. InariWatch connects the dots so
            you understand what happened, why, and what to do next.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Without */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <p className="text-sm font-semibold text-zinc-500 mb-5 font-mono uppercase tracking-widest">
              Without InariWatch — 3 notifications
            </p>
            <div className="space-y-3">
              {[
                { icon: "🔴", source: "Sentry",  text: "TypeError in auth.ts:47 — 23 users" },
                { icon: "🔴", source: "Vercel",  text: "Deploy failed — my-app production" },
                { icon: "⚠️", source: "GitHub",  text: "PR #47 merged 2h ago" },
              ].map((item) => (
                <div key={item.source} className="flex items-start gap-3 rounded-lg border border-inari-border bg-inari-card p-3">
                  <span className="text-base">{item.icon}</span>
                  <div>
                    <span className="text-xs text-zinc-500 uppercase tracking-wider">{item.source}</span>
                    <p className="text-sm text-zinc-300 mt-0.5">{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-zinc-600 italic">You: "Are these related? Let me check each tool..."</p>
          </div>

          {/* With */}
          <div className="rounded-xl border border-inari-accent/25 bg-inari-accent-dim p-6 shadow-[0_0_40px_rgba(124,58,237,0.06)]">
            <p className="text-sm font-semibold text-inari-accent mb-5 font-mono uppercase tracking-widest">
              With InariWatch — 1 correlated alert
            </p>
            <div className="rounded-lg border border-inari-border bg-zinc-950 p-4 font-mono text-sm">
              <p className="text-inari-accent">🔴 <span className="font-semibold text-white">Deploy failure caused new error</span></p>
              <p className="text-zinc-500 mt-2 leading-relaxed">
                PR #47 merged 2h ago modified auth.ts.<br />
                Deploy failed and introduced TypeError at line 47.<br />
                23 users affected.
              </p>
              <div className="mt-3 pt-3 border-t border-inari-border">
                <p className="text-zinc-400">
                  <span className="text-inari-accent">Root cause:</span> OAuth middleware broke session handling
                </p>
                <p className="text-zinc-400 mt-1">
                  <span className="text-inari-accent">Next step:</span> Revert PR #47 or patch the middleware
                </p>
              </div>
            </div>
            <p className="mt-4 text-sm text-zinc-500 italic">One message, full context, clear next action.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── How it works ──────────────────────────────────────────────────────────────

function HowItWorks() {
  return (
    <section className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Get started</p>
          <h2 className="text-3xl font-bold text-white sm:text-4xl">Up in 2 minutes</h2>
        </div>

        <div className="grid gap-12 lg:grid-cols-2 items-center">
          {/* Steps */}
          <div className="space-y-10">
            {[
              {
                step: "01",
                icon: <Terminal className="h-5 w-5" />,
                title: "Install the CLI or open the dashboard",
                body: "One curl command gets the local CLI. Or sign up for the cloud dashboard — no install required.",
              },
              {
                step: "02",
                icon: <Zap className="h-5 w-5" />,
                title: "Connect your stack",
                body: "Paste a GitHub token, Vercel token, or Sentry key. InariWatch auto-detects your repos and projects.",
              },
              {
                step: "03",
                icon: <Activity className="h-5 w-5" />,
                title: "Get smart alerts",
                body: "InariWatch polls every 5 minutes, correlates events with AI, and sends one actionable alert to Telegram, Slack, or email.",
              },
            ].map((item) => (
              <div key={item.step} className="flex gap-5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-inari-border bg-inari-card text-inari-accent">
                  {item.icon}
                </div>
                <div>
                  <p className="text-xs font-mono text-zinc-700 mb-1">{item.step}</p>
                  <h3 className="font-semibold text-white">{item.title}</h3>
                  <p className="mt-1.5 text-sm text-zinc-400 leading-relaxed">{item.body}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Terminal demo */}
          <div className="rounded-xl border border-inari-border bg-zinc-950 shadow-2xl overflow-hidden">
            <div className="flex items-center gap-2 border-b border-inari-border px-4 py-3">
              <div className="flex gap-1.5">
                <div className="h-3 w-3 rounded-full bg-red-500/80" />
                <div className="h-3 w-3 rounded-full bg-yellow-500/70" />
                <div className="h-3 w-3 rounded-full bg-green-500/70" />
              </div>
              <span className="ml-2 font-mono text-xs text-zinc-500">inari watch</span>
            </div>
            <div className="p-5 font-mono text-sm leading-7 space-y-0.5">
              <p>
                <span className="text-inari-accent">◉</span>
                <span className="text-zinc-300"> Watching </span>
                <span className="text-white font-semibold">my-app</span>
                <span className="text-zinc-500"> — AI </span>
                <span className="text-inari-accent">ON</span>
              </p>
              <p className="text-zinc-600">  Polling every 60s. Ctrl+C to stop.</p>
              <br />
              <p><span className="text-zinc-600">10:41:01  </span><span className="text-green-500">✓</span><span className="text-zinc-600"> all clear</span></p>
              <p><span className="text-zinc-600">10:42:01  </span><span className="text-green-500">✓</span><span className="text-zinc-600"> all clear</span></p>
              <p><span className="text-zinc-600">10:43:01  </span><span className="text-zinc-100">📨</span><span className="text-zinc-300"> 1 alert sent</span></p>
              <br />
              <p>
                <span className="text-inari-accent">🔴 </span>
                <span className="text-white font-semibold">Deploy failed + new Sentry error</span>
                <span className="text-zinc-600 text-xs"> [2 correlated]</span>
              </p>
              <p className="text-zinc-500">  Root cause: PR #47 broke OAuth session handling</p>
              <p className="text-zinc-500">  23 users affected · auth.ts:47 · 2h ago</p>
              <p className="text-zinc-500">  Next: revert PR #47 or patch auth middleware</p>
              <br />
              <p className="flex items-center gap-1">
                <span className="text-zinc-600">10:44:01  </span>
                <span className="text-green-500">✓</span>
                <span className="text-zinc-600"> all clear</span>
                <span className="cursor ml-1 text-inari-accent" />
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Pricing ───────────────────────────────────────────────────────────────────

function Pricing() {
  const plans = [
    {
      name: "Local",
      price: "Free",
      period: "forever",
      description: "CLI runs on your machine. Data stays local.",
      highlight: false,
      cta: { label: "Install CLI", href: "#" },
      features: [
        "Open source CLI",
        "GitHub, Vercel, Sentry, Git",
        "Telegram notifications",
        "AI correlation (BYOK)",
        "Works while laptop is on",
      ],
      missing: ["Web dashboard", "24/7 monitoring"],
    },
    {
      name: "Pro",
      price: "$9",
      period: "/month",
      description: "Cloud orchestrator running 24/7 on our servers.",
      highlight: true,
      cta: { label: "Start free trial", href: "/register" },
      features: [
        "Everything in Local",
        "24/7 cloud monitoring",
        "Web dashboard + alert history",
        "AI risk assessment + remediation",
        "Anomaly detection",
        "Up to 5 projects",
        "Telegram, Slack & email",
      ],
      missing: [],
    },
    {
      name: "Team",
      price: "$29",
      period: "/month",
      description: "For teams monitoring multiple projects.",
      highlight: false,
      cta: { label: "Start free trial", href: "/register?plan=team" },
      features: [
        "Everything in Pro",
        "Unlimited projects",
        "Multiple developers per project",
        "90-day alert history",
        "Priority support",
      ],
      missing: [],
    },
  ];

  return (
    <section id="pricing" className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Pricing</p>
          <h2 className="text-3xl font-bold text-white sm:text-4xl">Simple pricing</h2>
          <p className="mt-4 text-zinc-400">Start free. Upgrade when you need 24/7 coverage.</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-2xl border p-8 transition-all ${
                plan.highlight
                  ? "border-inari-accent/40 bg-inari-accent-dim shadow-[0_0_50px_rgba(124,58,237,0.10)]"
                  : "border-inari-border bg-inari-card"
              }`}
            >
              {plan.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-inari-accent px-3 py-1 text-xs font-semibold text-white shadow-[0_0_12px_rgba(124,58,237,0.4)]">
                    Most popular
                  </span>
                </div>
              )}

              <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">{plan.name}</p>
              <div className="mt-2 flex items-end gap-1">
                <span className="text-4xl font-bold text-white">{plan.price}</span>
                <span className="pb-1 text-zinc-500 text-sm">{plan.period}</span>
              </div>
              <p className="mt-2 text-sm text-zinc-500">{plan.description}</p>

              <Link href={plan.cta.href} className="mt-6 block">
                <Button variant={plan.highlight ? "primary" : "outline"} className="w-full">
                  {plan.cta.label}
                </Button>
              </Link>

              <ul className="mt-8 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-300">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-inari-accent" />
                    {f}
                  </li>
                ))}
                {plan.missing.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-700 line-through">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-800" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-inari-border py-10">
      <div className="mx-auto max-w-6xl px-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <Image src="/logo-inari/favicon-96x96.png" alt="InariWatch" width={28} height={28} />
          <span className="font-mono text-zinc-400 uppercase tracking-widest text-xs font-semibold">INARIWATCH</span>
        </div>
        <div className="flex items-center gap-6 text-sm text-zinc-600">
          <Link href="/docs" className="hover:text-zinc-400 transition-colors">Docs</Link>
          <a href="#" target="_blank" rel="noreferrer" className="hover:text-zinc-400 transition-colors">GitHub</a>
          <span>Built with Rust + Next.js</span>
        </div>
      </div>
    </footer>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-inari-bg">
      <Nav />
      <main>
        <Hero />
        <StatsBar />
        <Integrations />
        <AIFeatures />
        <CorrelationDemo />
        <HowItWorks />
        <Pricing />
      </main>
      <Footer />
    </div>
  );
}
