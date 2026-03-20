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
  ArrowRight,
  XCircle,
  RefreshCw,
  GitBranch,
  Shield,
  RotateCcw,
  Heart,
  Plus,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "./copy-button";
import { MarketingNav } from "./marketing-nav";

// ── Nav ───────────────────────────────────────────────────────────────────────

function Nav() {
  return <MarketingNav />;
}

// ── Hero ──────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden min-h-[680px] lg:min-h-[780px] flex items-center">
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
        <div className="absolute inset-0 bg-black/50 sm:bg-transparent sm:bg-gradient-to-r sm:from-black sm:via-black/90 sm:via-[52%] sm:to-black/10" />
        <div className="absolute bottom-0 inset-x-0 h-32 bg-gradient-to-t from-inari-bg to-transparent" />
        <div className="absolute top-0 inset-x-0 h-24 bg-gradient-to-b from-black/60 to-transparent" />
      </div>

      <div className="relative w-full pt-32 pb-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="max-w-xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-3 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-inari-accent animate-pulse" />
              <span className="text-xs font-mono text-inari-accent">AI writes the fix while you sleep</span>
            </div>

            <h1 className="text-5xl font-bold tracking-tight text-white sm:text-6xl lg:text-7xl leading-[1.05]">
              Your CI broke.
              <br />
              <span className="text-gradient-accent glow-accent-text">PR is already open.</span>
            </h1>

            <p className="mt-6 text-lg text-zinc-300 leading-relaxed max-w-md">
              InariWatch monitors GitHub, Vercel, Sentry, and more.
              When something breaks, AI reads your code, writes the fix,
              waits for CI, and opens a PR.{" "}
              <span className="text-white">You just approve.</span>
            </p>

            <div className="mt-10 flex flex-col gap-3 max-w-md">
              <Link href="/register" className="w-full">
                <Button variant="primary" className="w-full py-3 text-base">
                  Start free — no install required
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <div className="group flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm px-4 py-3 font-mono text-sm hover:border-white/20 transition-colors">
                <span className="text-inari-accent select-none">$</span>
                <span className="flex-1 text-zinc-300">curl -fsSL https://get.inariwatch.com | sh</span>
                <CopyButton text="curl -fsSL https://get.inariwatch.com | sh" />
              </div>
            </div>

            <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/50">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                BYOK — your AI key, your costs
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                Claude, OpenAI, Grok, DeepSeek, Gemini
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                Start free, no credit card required
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
    { value: "7", label: "integrations monitored" },
    { value: "1 min", label: "cloud poll interval" },
    { value: "3×", label: "CI retry loop" },
    { value: "5", label: "AI providers supported" },
  ];

  return (
    <div className="border-y border-inari-border bg-inari-card/40">
      <div className="mx-auto max-w-6xl px-6 py-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <p className="text-2xl font-bold text-fg-strong font-mono">{s.value}</p>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Remediation walkthrough ───────────────────────────────────────────────────

function RemediationWalkthrough() {
  const steps = [
    {
      icon: <Activity className="h-4 w-4" />,
      n: "01",
      title: "Alert fires",
      desc: "CI fails, deploy errors, Sentry regression — caught in real time via webhook or 1-min poll.",
    },
    {
      icon: <Brain className="h-4 w-4" />,
      n: "02",
      title: "AI reads your code",
      desc: "Connects to your repo, fetches relevant files, diagnoses the root cause from the actual stack.",
    },
    {
      icon: <Wrench className="h-4 w-4" />,
      n: "03",
      title: "Fix generated",
      desc: "AI writes the code change with a plain-English explanation — not a generic suggestion, an actual diff.",
    },
    {
      icon: <RefreshCw className="h-4 w-4" />,
      n: "04",
      title: "CI validated (with retry)",
      desc: "Pushes to a branch, monitors CI. If it fails, reads the logs and tries a different fix — up to 3×.",
    },
    {
      icon: <GitBranch className="h-4 w-4" />,
      n: "05",
      title: "PR opened",
      desc: "When CI passes, opens a PR with full context. You get a notification. One click to approve.",
    },
  ];

  return (
    <section className="py-24 border-t border-inari-border bg-inari-card/20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 max-w-xl">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">AI Remediation</p>
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl">
            Monitoring tools tell you what broke.
            <br />
            <span className="text-inari-accent">InariWatch fixes it.</span>
          </h2>
          <p className="mt-4 text-fg-base">
            No other monitoring tool closes the loop from alert to merged fix.
            Here's exactly what happens the moment something breaks.
          </p>
        </div>

        {/* Steps */}
        <div className="grid gap-4 sm:grid-cols-5 mb-10">
          {steps.map((step, i) => (
            <div key={step.n} className="relative flex flex-col gap-3 rounded-xl border border-inari-border bg-inari-card p-5">
              {i < steps.length - 1 && (
                <div className="hidden sm:block absolute -right-2 top-1/2 -translate-y-1/2 z-10">
                  <ArrowRight className="h-4 w-4 text-zinc-700" />
                </div>
              )}
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-inari-accent/10 text-inari-accent">
                  {step.icon}
                </div>
                <span className="font-mono text-[11px] text-zinc-600">{step.n}</span>
              </div>
              <p className="text-sm font-semibold text-fg-strong">{step.title}</p>
              <p className="text-xs text-zinc-500 leading-relaxed">{step.desc}</p>
            </div>
          ))}
        </div>

        {/* Terminal showing live remediation */}
        <div className="rounded-xl border border-inari-accent/25 bg-zinc-950 overflow-hidden shadow-[0_0_60px_rgba(124,58,237,0.08)]">
          <div className="flex items-center gap-2 border-b border-inari-border px-4 py-3">
            <div className="flex gap-1.5">
              <div className="h-3 w-3 rounded-full bg-red-500/80" />
              <div className="h-3 w-3 rounded-full bg-yellow-500/70" />
              <div className="h-3 w-3 rounded-full bg-green-500/70" />
            </div>
            <span className="ml-2 font-mono text-xs text-zinc-500">InariWatch — Live remediation</span>
          </div>
          <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-inari-border">
            {/* Left: alert */}
            <div className="p-5 font-mono text-sm leading-7">
              <p className="text-zinc-500 text-xs mb-3 uppercase tracking-widest">03:12 — alert received</p>
              <p>
                <span className="text-inari-accent">🔴 </span>
                <span className="text-white font-semibold">CI failing on main</span>
              </p>
              <p className="text-zinc-500">  TypeError: Cannot read 'user' of undefined</p>
              <p className="text-zinc-500">  auth/session.ts:84 · build #1247</p>
              <p className="text-zinc-500">  Triggered by: PR #61 merged 4 min ago</p>
              <br />
              <p className="text-zinc-600">→ Starting AI remediation...</p>
              <p className="text-zinc-600">→ Reading auth/session.ts, lib/auth.ts</p>
              <p className="text-zinc-600">→ Generating fix...</p>
              <p className="text-zinc-600">→ Pushing branch fix/session-null-check</p>
              <p className="text-zinc-600">→ Waiting for CI...</p>
              <p className="text-green-500">→ CI passed ✓</p>
              <p className="text-inari-accent font-semibold">→ PR #62 opened</p>
            </div>
            {/* Right: PR description */}
            <div className="p-5 font-mono text-sm leading-relaxed">
              <p className="text-zinc-500 text-xs mb-3 uppercase tracking-widest">03:14 — PR ready for review</p>
              <p className="text-white font-semibold">fix: add null check for session.user</p>
              <br />
              <p className="text-zinc-400">Root cause: PR #61 refactored the session</p>
              <p className="text-zinc-400">object but auth/session.ts still assumed</p>
              <p className="text-zinc-400">user was always defined on the response.</p>
              <br />
              <p className="text-zinc-400">Changed:</p>
              <p className="text-red-400/80">  - return session.user.id</p>
              <p className="text-green-400/80">  + return session.user?.id ?? null</p>
              <br />
              <p className="text-zinc-600">CI: ✓ all checks passed</p>
              <p className="text-inari-accent">Waiting for your approval →</p>
            </div>
          </div>
        </div>

        <p className="mt-5 text-center text-sm text-zinc-600">
          From alert to ready-to-merge PR in under 2 minutes. While you were sleeping.
        </p>
      </div>
    </section>
  );
}

// ── Why not native alerts ─────────────────────────────────────────────────────

function WhyNotNative() {
  return (
    <section className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 max-w-xl">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Better Together</p>
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl">
            They provide the signals. We provide the fix.
          </h2>
          <p className="mt-4 text-fg-base leading-relaxed">
            InariWatch isn't here to replace GitHub, Vercel, or Sentry. They are best-in-class at what they do. InariWatch simply connects them into a unified brain, automatically correlating their signals and finding the root cause.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 mb-12">
          {/* Without */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-5">
              The Foundation: Your Stack
            </p>

            <div className="space-y-3">
              {[
                { src: "GitHub", icon: "📧", text: "Workflow failed on main" },
                { src: "Vercel", icon: "📧", text: "Production deploy errored" },
                { src: "Sentry", icon: "📧", text: "TypeError: 23 new events" },
              ].map((item) => (
                <div
                  key={item.src}
                  className="flex items-start gap-3 rounded-lg border border-inari-border bg-inari-card p-3"
                >
                  <span>{item.icon}</span>
                  <div>
                    <span className="text-xs text-zinc-600 uppercase tracking-wider">
                      {item.src}
                    </span>
                    <p className="text-sm text-fg-base mt-0.5">{item.text}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-1.5">
              {[
                "Sentry catches the exact error instantly",
                "Vercel manages your deployments flawlessly",
                "GitHub Actions runs your CI reliably",
                "But these critical signals operate in silos.",
              ].map((item, idx) => (
                <div
                  key={item}
                  className="flex items-start gap-2 text-sm text-zinc-400"
                >
                  {idx === 3 ? (
                    <span className="text-inari-accent mt-0.5">↳</span>
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-zinc-600 mt-0.5" />
                  )}
                  <span className={idx === 3 ? "text-fg-base" : ""}>{item}</span>
                </div>
              ))}
            </div>
          </div>

          {/* With InariWatch */}
          <div className="rounded-xl border border-inari-accent/25 bg-inari-accent-dim p-6">
            <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-5">
              The Superpower: InariWatch
            </p>

            <div className="rounded-lg border border-inari-border bg-zinc-950 p-4 font-mono text-sm mb-4">
              <p className="text-inari-accent font-semibold">
                🔴 Deploy failure caused by TypeError
              </p>
              <p className="text-zinc-400 mt-2 text-xs leading-relaxed">
                PR #61 modified session handling → deploy failed →<br />
                TypeError at auth/session.ts:84 · 23 users affected
              </p>
              <p className="text-inari-accent text-xs mt-2">
                PR #62 ready to merge → CI ✓
              </p>
            </div>

            <div className="space-y-1.5">
              {[
                "Signals automatically correlated across your stack",
                "Root cause identified instantly",
                "Fix prepared and validated",
                "Issues resolved — even while you sleep",
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-2 text-sm text-fg-base"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-inari-accent" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Comparison table */}
        <div className="overflow-hidden rounded-xl border border-inari-border">
          <div className="grid grid-cols-3 border-b border-inari-border bg-inari-card px-4 py-3">
            <div className="text-xs text-zinc-500 font-medium">Capability</div>
            {["Datadog / PagerDuty", "InariWatch"].map((h, i) => (
              <div key={h} className={`text-xs font-medium text-center ${i === 1 ? "text-inari-accent" : "text-zinc-500"}`}>{h}</div>
            ))}
          </div>
          {[
            { cap: "Alert aggregation", dd: true, us: true },
            { cap: "Incident Storm Control", dd: "Paid", us: true },
            { cap: "Cross-service correlation", dd: false, us: true },
            { cap: "On-Call Rotations & Overrides", dd: "Paid", us: true },
            { cap: "Interactive Chat ACK (Telegram, etc)", dd: "Paid", us: true },
            { cap: "Root cause AI analysis", dd: "Paid", us: "BYOK" },
            { cap: "Writes code fix", dd: false, us: true },
            { cap: "Pushes branch + waits for CI", dd: false, us: true },
            { cap: "Pre-deploy PR risk scoring", dd: false, us: true },
            { cap: "Anomaly detection", dd: "Paid", us: true },
            { cap: "Open source CLI", dd: false, us: true },
            { cap: "BYOK (your AI key)", dd: false, us: true },
          ].map((row, idx) => (
            <div key={row.cap} className={`grid grid-cols-3 border-b border-inari-border last:border-0 px-4 py-3 ${idx % 2 === 0 ? "bg-inari-bg" : "bg-inari-card/30"}`}>
              <span className="text-sm text-fg-base">{row.cap}</span>
              {[row.dd, row.us].map((val, i) => (
                <div key={i} className="flex items-center justify-center">
                  {typeof val === "boolean" ? (
                    val
                      ? <CheckCircle2 className={`h-4 w-4 ${i === 1 ? "text-inari-accent" : "text-inari-accent/50"}`} />
                      : <XCircle className="h-4 w-4 text-zinc-700 opacity-40" />
                  ) : (
                    <span className={`text-xs font-medium ${i === 1 ? "text-inari-accent" : "text-zinc-500"}`}>{val}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Integrations ──────────────────────────────────────────────────────────────

function Integrations() {
  const integrations = [
    {
      name: "GitHub",
      alerts: ["Failed CI checks", "Stale & unreviewed PRs", "Pre-deploy risk on PRs"],
      status: "live",
    },
    {
      name: "Vercel",
      alerts: ["Failed production deploys", "Failed preview deploys", "Instant rollback"],
      status: "live",
    },
    {
      name: "Sentry",
      alerts: ["New issues", "Regressions (resolved → reopen)"],
      status: "live",
    },
    {
      name: "Uptime",
      alerts: ["Endpoint downtime", "Slow response time (configurable)"],
      status: "live",
    },
    {
      name: "PostgreSQL",
      alerts: ["Connection failures", "High connections", "Long-running queries"],
      status: "live",
    },
    {
      name: "npm / Cargo",
      alerts: ["Critical CVEs", "High-severity vulnerabilities"],
      status: "live",
    },
  ];

  return (
    <section id="integrations" className="py-24 border-t border-inari-border overflow-hidden">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Integrations</p>
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl max-w-lg">
            Monitors your entire stack
          </h2>
          <p className="mt-4 text-fg-base max-w-md">
            GitHub CI, Vercel deploys, Sentry errors, uptime, database health,
            dependency vulnerabilities — all in one place, already correlated.
          </p>
        </div>

        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] items-start">
          <div className="relative rounded-2xl overflow-hidden aspect-square lg:aspect-[3/4] hidden lg:block">
            <Image
              src="/integration.png"
              alt="Inari fox watching your integrations"
              fill
              className="object-cover object-center"
              quality={85}
            />
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-inari-bg" />
            <div className="absolute bottom-0 inset-x-0 h-24 bg-gradient-to-t from-inari-bg to-transparent" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {integrations.map((item) => (
              <div
                key={item.name}
                className="rounded-xl border border-inari-border bg-inari-card p-5 hover:border-inari-accent/30 hover:shadow-[0_0_20px_rgba(124,58,237,0.06)] transition-all"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-fg-strong">{item.name}</h3>
                  <span className="text-xs font-mono text-inari-accent bg-inari-accent-dim px-2 py-0.5 rounded-full border border-inari-accent/20">
                    live
                  </span>
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
      icon: <Wrench className="h-5 w-5" />,
      title: "AI Code Remediation",
      body: "Reads your repo, writes the fix, pushes a branch, waits for CI. If CI fails, reads the logs and retries with a different approach — up to 3 times. Opens the PR only when it passes.",
      tag: "Unique",
      highlight: true,
    },
    {
      icon: <GitPullRequest className="h-5 w-5" />,
      title: "Pre-deploy Risk Assessment",
      body: "AI reads every PR diff against your actual incident history and posts a risk score (Low / Medium / High) directly on GitHub before you merge. No config needed.",
      tag: "GitHub PRs",
      highlight: true,
    },
    {
      icon: <TrendingUp className="h-5 w-5" />,
      title: "Anomaly Detection",
      body: "Detects alert frequency spikes (3–5× vs baseline), repeating failure loops, integration degradation, and silent projects — proactively, before they escalate.",
      tag: "Proactive",
    },
    {
      icon: <Brain className="h-5 w-5" />,
      title: "Alert Correlation",
      body: "When Vercel fails and Sentry spikes at the same time, AI groups them into one correlated alert with a single root cause. 5 alerts become 1 actionable message.",
      tag: "Smart alerts",
    },
    {
      icon: <MessageSquare className="h-5 w-5" />,
      title: "Ask Inari",
      body: "Chat with your live monitoring data. \"What failed this week?\", \"Which integration has the most errors?\", \"Summarize last night's incidents.\" Inari has the context.",
      tag: "Ops copilot",
    },
    {
      icon: <Bell className="h-5 w-5" />,
      title: "On-Call Rotations",
      body: "Set up timezone-aware schedules with multi-level escalations. When a critical issue happens, InariWatch pages the specific developer on-call (and escalates if they don't respond).",
      tag: "PagerDuty Alternative",
    },
    {
      icon: <MessageSquare className="h-5 w-5" />,
      title: "Interactive Chat ACK",
      body: "Acknowledge or resolve alerts directly from Telegram or Slack using interactive inline buttons. No need to open your laptop at 3 AM just to silence an alarm.",
      tag: "Frictionless",
    },
    {
      icon: <Shield className="h-5 w-5" />,
      title: "Incident Storm Control",
      body: "When your database crashes, you get 1 correlated 'Incident Storm' alert instead of 50 individual service failure emails. Silence the noise when the whole stack is burning.",
      tag: "Alert Fatigue",
    },
    {
      icon: <Activity className="h-5 w-5" />,
      title: "Uptime Monitoring",
      body: "Constant 1-minute global pings to your endpoints. If your site goes down, InariWatch catches it instantly, creates an alert, and updates your Status Page.",
      tag: "1-min pings",
    },
  ];

  return (
    <section id="features" className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Platform</p>
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl max-w-lg">
            A complete automated monitoring platform
          </h2>
          <p className="mt-4 text-fg-base max-w-md">
            Bring your own AI key (Claude, OpenAI, Grok, DeepSeek, or Gemini).
            InariWatch uses it to turn raw events into decisions — and decisions into PRs.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <div
              key={f.title}
              className={`group rounded-xl border p-6 transition-all hover:shadow-[0_0_24px_rgba(124,58,237,0.07)] ${f.highlight
                ? "border-inari-accent/30 bg-inari-accent-dim hover:border-inari-accent/50"
                : "border-inari-border bg-inari-card hover:border-inari-accent/30"
                }`}
            >
              <div className="mb-4 flex items-center justify-between">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg border text-inari-accent transition-colors ${f.highlight ? "border-inari-accent/30 bg-inari-accent/10" : "border-inari-border bg-inari-bg group-hover:border-inari-accent/30"
                  }`}>
                  {f.icon}
                </div>
                <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${f.highlight
                  ? "text-inari-accent bg-inari-accent/10 border border-inari-accent/20"
                  : "text-zinc-600 bg-zinc-800/50"
                  }`}>
                  {f.tag}
                </span>
              </div>
              <h3 className="font-semibold text-fg-strong mb-2">{f.title}</h3>
              <p className="text-sm text-fg-base leading-relaxed">{f.body}</p>
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
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl max-w-lg">
            One alert instead of six
          </h2>
          <p className="mt-4 text-fg-base max-w-md">
            Each tool does its job — GitHub watches CI, Vercel watches deploys,
            Sentry watches errors. InariWatch connects them.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <p className="text-sm font-semibold text-zinc-500 mb-5 font-mono uppercase tracking-widest">
              Without InariWatch — 3 separate notifications
            </p>
            <div className="space-y-3">
              {[
                { icon: "🔴", source: "Sentry", text: "TypeError in auth.ts:47 — 23 users" },
                { icon: "🔴", source: "Vercel", text: "Deploy failed — my-app production" },
                { icon: "⚠️", source: "GitHub", text: "PR #47 merged 2h ago" },
              ].map((item) => (
                <div key={item.source} className="flex items-start gap-3 rounded-lg border border-inari-border bg-inari-card p-3">
                  <span className="text-base">{item.icon}</span>
                  <div>
                    <span className="text-xs text-zinc-500 uppercase tracking-wider">{item.source}</span>
                    <p className="text-sm text-fg-base mt-0.5">{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-zinc-500 italic">You: "Are these related? Let me check each tool..."</p>
          </div>

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
                  <span className="text-inari-accent">Fix:</span> PR #48 opened — CI passing ✓
                </p>
              </div>
            </div>
            <p className="mt-4 text-sm text-zinc-500 italic">One message, full context, PR already ready.</p>
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
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl">Up in 2 minutes</h2>
        </div>

        <div className="grid gap-12 lg:grid-cols-2 items-center">
          <div className="space-y-10">
            {[
              {
                step: "01",
                icon: <Terminal className="h-5 w-5" />,
                title: "Install the CLI or open the dashboard",
                body: "One curl command for the local CLI. Or sign up for the web dashboard — no install, no card.",
              },
              {
                step: "02",
                icon: <Zap className="h-5 w-5" />,
                title: "Connect your stack",
                body: "Paste a GitHub token, Vercel token, or Sentry key. InariWatch auto-detects your repos, projects, and orgs.",
              },
              {
                step: "03",
                icon: <Shield className="h-5 w-5" />,
                title: "Add your AI key (optional)",
                body: "Connect Claude, OpenAI, Grok, DeepSeek, or Gemini. Your key goes directly to the provider — we never proxy it.",
              },
              {
                step: "04",
                icon: <Activity className="h-5 w-5" />,
                title: "Incidents handled automatically",
                body: "InariWatch monitors 24/7, correlates events, and when something breaks — diagnoses, fixes, and opens a PR.",
              },
            ].map((item) => (
              <div key={item.step} className="flex gap-5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-inari-border bg-inari-card text-inari-accent">
                  {item.icon}
                </div>
                <div>
                  <p className="text-xs font-mono text-zinc-500 mb-1">{item.step}</p>
                  <h3 className="font-semibold text-fg-strong">{item.title}</h3>
                  <p className="mt-1.5 text-sm text-fg-base leading-relaxed">{item.body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-inari-border bg-zinc-950 shadow-2xl overflow-hidden">
            <div className="flex items-center gap-2 border-b border-inari-border px-4 py-3">
              <div className="flex gap-1.5">
                <div className="h-3 w-3 rounded-full bg-red-500/80" />
                <div className="h-3 w-3 rounded-full bg-yellow-500/70" />
                <div className="h-3 w-3 rounded-full bg-green-500/70" />
              </div>
              <span className="ml-2 font-mono text-xs text-zinc-500">inariwatch watch</span>
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
              <p><span className="text-zinc-600">03:11  </span><span className="text-green-500">✓</span><span className="text-zinc-600"> all clear</span></p>
              <p><span className="text-zinc-600">03:12  </span><span className="text-zinc-100">📨</span><span className="text-zinc-300"> 1 alert — remediating</span></p>
              <br />
              <p>
                <span className="text-inari-accent">🔴 </span>
                <span className="text-white font-semibold">CI failing on main</span>
              </p>
              <p className="text-zinc-500">  Root: session.user null after PR #61</p>
              <p className="text-zinc-500">  Fix: null check added · CI ✓</p>
              <p className="text-inari-accent">  PR #62 opened — waiting for approval</p>
              <br />
              <p className="flex items-center gap-1">
                <span className="text-zinc-600">03:13  </span>
                <span className="text-green-500">✓</span>
                <span className="text-zinc-600"> all clear</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Open Source & Free Model ──────────────────────────────────────────────────

function OpenSourceModel() {
  return (
    <section id="model" className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-5xl px-6">
        <div className="text-center mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Model</p>
          <h2 className="text-3xl font-bold text-fg-strong sm:text-5xl">100% Free. Bring your own key.</h2>
          <p className="mt-5 text-lg text-fg-base max-w-2xl mx-auto leading-relaxed">
            There are no restrictive tiers, no credit cards, and no paywalls. InariWatch is built on a hybrid model to keep the community moving fast.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* CLI */}
          <div className="rounded-2xl border border-inari-border bg-inari-card p-8 flex flex-col">
            <div className="flex items-center gap-3 mb-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-inari-border bg-inari-bg text-fg-strong">
                <Terminal className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-fg-strong text-lg">Local CLI</h3>
                <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mt-0.5">Open Source</p>
              </div>
            </div>
            <p className="text-sm text-fg-base mb-6 leading-relaxed">
              Written in Rust. Runs locally on your machine. Parses errors and sends you Telegram notifications without your data ever hitting our servers.
            </p>
            <ul className="mt-auto space-y-3">
              {[
                "100% Open Source (MIT)",
                "No cloud dependencies",
                "Unlimited local projects",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-fg-base">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                  {f}
                </li>
              ))}
            </ul>
            <a href="#" className="mt-8 block">
              <Button variant="outline" className="w-full">View on GitHub</Button>
            </a>
          </div>

          {/* Web */}
          <div className="relative rounded-2xl border border-inari-accent/40 bg-inari-accent-dim p-8 flex flex-col shadow-[0_0_50px_rgba(124,58,237,0.10)]">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="rounded-full bg-inari-accent px-3 py-1 text-xs font-semibold text-white shadow-[0_0_12px_rgba(124,58,237,0.4)]">
                Most popular
              </span>
            </div>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-inari-accent/30 bg-inari-accent/10 text-inari-accent">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-fg-strong text-lg">Cloud Dashboard</h3>
                <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mt-0.5">Free SaaS</p>
              </div>
            </div>
            <p className="text-sm text-fg-base mb-6 leading-relaxed">
              Full autonomous incident response. We host the dashboard, the 24/7 cron jobs, and the webhooks for free. You just provide your AI API key.
            </p>
            <ul className="mt-auto space-y-3">
              {[
                "AI writes & pushes code fixes",
                "Team Workspaces included",
                "1-min cloud polling, 24/7",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-fg-base">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-inari-accent" />
                  {f}
                </li>
              ))}
            </ul>
            <Link href="/register" className="mt-8 block">
              <Button variant="primary" className="w-full">Start using for free</Button>
            </Link>
          </div>
        </div>

        <div className="mt-14 rounded-2xl border border-inari-border bg-inari-card p-8 text-center max-w-2xl mx-auto">
           <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-zinc-900 border border-zinc-800 mb-4 shadow-[0_0_15px_rgba(255,255,255,0.05)]">
             <Heart className="h-5 w-5 text-red-500 fill-red-500/20" />
           </div>
           <h3 className="text-lg font-bold text-fg-strong mb-2">How do we make money?</h3>
           <p className="text-sm text-fg-base leading-relaxed mb-6">
             We rely on community sponsorships. Our cloud infrastructure is hyper-optimized so we can offer it for free. If InariWatch saves your engineering team hours every week, consider sponsoring the project so we can keep it free for solo developers everywhere.
           </p>
           <a href="#">
             <Button variant="outline">Sponsor InariWatch</Button>
           </a>
        </div>
      </div>
    </section>
  );
}

// ── Sponsors ──────────────────────────────────────────────────────────────────

function Sponsors() {
  return (
    <section className="border-t border-b border-inari-border bg-inari-card/20 py-12">
      <div className="mx-auto max-w-6xl px-6 text-center">
        <p className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-8 font-semibold">
          Developed with the support of our visionary sponsors
        </p>
        <div className="flex flex-wrap justify-center gap-10 sm:gap-16 opacity-70 grayscale hover:grayscale-0 transition-all duration-300">
          
          <a
            href="https://orbitapos.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 group"
          >
            <div className="h-8 w-8 rounded-md bg-inari-accent flex items-center justify-center shadow-[0_0_15px_rgba(124,58,237,0.4)] group-hover:shadow-[0_0_25px_rgba(124,58,237,0.7)] transition-shadow">
              <span className="text-white font-bold text-lg leading-none tracking-tighter">O</span>
            </div>
            <span className="font-bold text-xl tracking-tight text-white/90 group-hover:text-white transition-colors">
              OrbitaPOS
            </span>
          </a>
          
          <a
            href="https://github.com/sponsors/inariwatch"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 group opacity-50 hover:opacity-100"
          >
            <div className="h-8 w-8 rounded-md border border-dashed border-zinc-600 flex items-center justify-center text-zinc-500 group-hover:border-inari-accent group-hover:text-inari-accent transition-colors">
              <Plus className="h-4 w-4" />
            </div>
            <span className="font-medium text-lg tracking-tight text-zinc-500 group-hover:text-inari-accent transition-colors">
              Sponsor InariWatch
            </span>
          </a>

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
          <span className="font-mono text-fg-base uppercase tracking-widest text-xs font-semibold">INARIWATCH</span>
        </div>
        <div className="flex items-center gap-6 text-sm text-zinc-500">
          <Link href="/docs" className="hover:text-fg-base transition-colors">Docs</Link>
          <a href="#" target="_blank" rel="noreferrer" className="hover:text-fg-base transition-colors">Sponsor</a>
          <a href="#" target="_blank" rel="noreferrer" className="hover:text-fg-base transition-colors">GitHub</a>
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
        <Sponsors />
        <StatsBar />
        <RemediationWalkthrough />
        <WhyNotNative />
        <Integrations />
        <AIFeatures />
        <CorrelationDemo />
        <HowItWorks />
        <OpenSourceModel />
      </main>
      <Footer />
    </div>
  );
}
