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
  Wrench,
  ArrowRight,
  XCircle,
  RefreshCw,
  GitBranch,
  Shield,
  RotateCcw,
  Bell,
  Code2,
  Plug,
  Wand2,
  Hash,
  Monitor,
  Film,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InstallSnippet } from "./install-snippet";
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
              InariWatch monitors GitHub, Vercel, Sentry, and your own app
              via <span className="text-white font-medium">@inariwatch/capture</span>.
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
              <InstallSnippet />
            </div>

            <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm text-white/50">
              <a
                href="https://github.com/orbita-pos/inariwatch"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 hover:text-white transition-colors"
              >
                <Github className="h-3.5 w-3.5" />
                <img
                  src="https://img.shields.io/github/stars/orbita-pos/inariwatch?style=flat&color=7c3aed&labelColor=18181b"
                  alt="GitHub stars"
                  className="h-5"
                />
              </a>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                AI analysis included — no key needed
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                Open source (MIT)
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Demo video ───────────────────────────────────────────────────────────────

function DemoVideo() {
  return (
    <section className="py-12 bg-inari-bg">
      <div className="mx-auto max-w-4xl px-6">
        <div className="rounded-2xl border border-inari-accent/20 overflow-hidden shadow-2xl shadow-purple-500/10">
          <video
            autoPlay
            loop
            muted
            playsInline
            className="w-full"
            poster="/demo-poster.png"
          >
            <source
              src="/demo.mp4"
              type="video/mp4"
            />
          </video>
        </div>
        <p className="text-center text-xs text-zinc-600 mt-3">
          From error to merged PR in 2 minutes. Fully automated.
        </p>
      </div>
    </section>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar() {
  const stats = [
    { value: "8", label: "integrations monitored" },
    { value: "5 min", label: "cloud poll interval" },
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
      desc: "CI fails, deploy errors, Sentry regression, or your own app via @inariwatch/capture — caught in real time.",
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

// ── Auto-merge safety ─────────────────────────────────────────────────────────

function AutoMergeSafety() {
  const gates = [
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "CI required",
      detail: "All tests must pass before any merge is considered",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "Confidence ≥ 90%",
      detail: "Diagnosis must be clear — low-confidence fixes become draft PRs",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "AI self-review ≥ 70/100",
      detail: "A second AI call reviews the fix like a senior engineer before it ships",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "≤ 50 lines changed",
      detail: "Large or complex changes are always sent as draft PRs for human review",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "Auto-merge enabled",
      detail: "You activate this per project — off by default, always in your control",
    },
  ];

  return (
    <section className="py-24 border-t border-inari-border bg-inari-card/20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-16 lg:grid-cols-2 items-start">
          {/* Left: copy + gates */}
          <div>
            <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">
              Auto-merge
            </p>
            <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl leading-tight">
              You sleep. We ship.
              <br />
              <span className="text-inari-accent">Safely.</span>
            </h2>
            <p className="mt-4 text-fg-base leading-relaxed max-w-md">
              Skeptical about AI auto-merging code into production? Fair. Here's
              how we make sure every auto-merged fix is something we'd sign off
              on ourselves.
            </p>

            <p className="mt-8 text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">
              5 gates — all must pass to auto-merge
            </p>

            <div className="space-y-3">
              {gates.map((gate) => (
                <div
                  key={gate.label}
                  className="flex items-start gap-3 rounded-xl border border-inari-border bg-inari-card p-4"
                >
                  <div className="mt-0.5 shrink-0">{gate.icon}</div>
                  <div>
                    <p className="text-sm font-semibold text-fg-strong">
                      {gate.label}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                      {gate.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: live terminal */}
          <div className="space-y-4">
            {/* Terminal */}
            <div className="rounded-xl border border-inari-accent/25 bg-zinc-950 overflow-hidden shadow-[0_0_60px_rgba(124,58,237,0.08)]">
              <div className="flex items-center gap-2 border-b border-inari-border px-4 py-3">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-red-500/80" />
                  <div className="h-3 w-3 rounded-full bg-yellow-500/70" />
                  <div className="h-3 w-3 rounded-full bg-green-500/70" />
                </div>
                <span className="ml-2 font-mono text-xs text-zinc-500">
                  03:47 — auto-merge triggered
                </span>
              </div>
              <div className="p-5 font-mono text-sm leading-7 space-y-0.5">
                <p className="text-zinc-600 text-xs uppercase tracking-wider mb-3">
                  Evaluating safety gates...
                </p>
                <p>
                  <span className="text-emerald-400">✓ </span>
                  <span className="text-zinc-400">CI passed</span>
                  <span className="text-zinc-600"> (3 checks)</span>
                </p>
                <p>
                  <span className="text-emerald-400">✓ </span>
                  <span className="text-zinc-400">Confidence </span>
                  <span className="text-white font-semibold">94%</span>
                  <span className="text-zinc-600"> ≥ 90% threshold</span>
                </p>
                <p>
                  <span className="text-emerald-400">✓ </span>
                  <span className="text-zinc-400">Self-review </span>
                  <span className="text-white font-semibold">88/100</span>
                  <span className="text-zinc-600"> — approved</span>
                </p>
                <p>
                  <span className="text-emerald-400">✓ </span>
                  <span className="text-zinc-400">Lines changed: </span>
                  <span className="text-white font-semibold">12</span>
                  <span className="text-zinc-600"> ≤ 50 max</span>
                </p>
                <p>
                  <span className="text-emerald-400">✓ </span>
                  <span className="text-zinc-400">Auto-merge enabled</span>
                </p>
                <br />
                <p className="text-inari-accent font-semibold">
                  → All gates passed — merging PR #62...
                </p>
                <p>
                  <span className="text-emerald-400">✓ </span>
                  <span className="text-zinc-300 font-semibold">
                    Merged. Watching for regressions (10 min)
                  </span>
                </p>

                {/* Monitoring progress bar */}
                <div className="mt-4 pt-4 border-t border-inari-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-500">Post-merge monitoring</span>
                    <span className="text-xs text-zinc-600">600s</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-1.5">
                    <div className="bg-emerald-500 h-1.5 rounded-full w-full" />
                  </div>
                  <p className="text-xs text-zinc-600 mt-2">
                    Sentry: <span className="text-emerald-400">ok</span>
                    {"  "}Uptime: <span className="text-emerald-400">ok</span>
                  </p>
                </div>
                <p className="text-emerald-400 font-semibold mt-2">
                  ✓ No regressions detected — fix is stable.
                </p>
              </div>
            </div>

            {/* Auto-revert callout */}
            <div className="rounded-xl border border-amber-900/30 bg-amber-950/10 p-5">
              <div className="flex items-start gap-3">
                <RotateCcw className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-300">
                    Regression detected? We revert automatically.
                  </p>
                  <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                    If Sentry catches the same error or uptime drops after a merge,
                    InariWatch opens a revert PR and merges it — all within the
                    10-minute monitoring window. You wake up to a stable main branch.
                  </p>
                </div>
              </div>
            </div>

            <p className="text-xs text-zinc-600 text-center">
              Auto-merge is off by default. You enable it per project, set your
              own confidence threshold, and define the max diff size.{" "}
              <Link href="/trust" className="text-inari-accent hover:text-inari-accent/80 underline underline-offset-2">
                Read the full Trust Architecture →
              </Link>
            </p>
          </div>
        </div>
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
            { cap: "Self-capture SDK (@inariwatch/capture)", dd: false, us: true },
            { cap: "Fully open source (MIT)", dd: false, us: true },
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
    {
      name: "Datadog",
      alerts: ["Log anomalies", "Infrastructure spikes", "APM Traces"],
      status: "live",
    },
    {
      name: "@inariwatch/capture",
      alerts: ["Exceptions from your app", "Custom log events", "Deploy markers"],
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
            GitHub CI, Vercel deploys, Sentry errors, Datadog monitors, uptime,
            database health, dependency vulnerabilities, and your own app via the capture SDK — all in one place, already correlated.
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
    {
      icon: <Hash className="h-5 w-5" />,
      title: "Slack Bot",
      body: "Errors arrive in Slack with AI diagnosis. Click Fix It to trigger remediation — progress, PR link, and Approve & Merge all in-thread. Ask @InariWatch questions, manage on-call, monitor deploys.",
      tag: "Control surface",
      highlight: true,
    },
    {
      icon: <Monitor className="h-5 w-5" />,
      title: "VS Code Extension",
      body: "Errors appear as inline squiggly lines in your editor. Hover for AI diagnosis. Sidebar shows all alerts grouped by file. Status bar shows unread count. Works in local mode too.",
      tag: "In your editor",
    },
    {
      icon: <Film className="h-5 w-5" />,
      title: "Substrate I/O Recording",
      body: "Capture every HTTP call, DB query, and file operation. When an error occurs, the last 60 seconds of I/O are attached to the alert. The AI sees exactly what your code did.",
      tag: "Full trace",
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
            Alert analysis and correlation are included free. Bring your own AI key
            (Claude, OpenAI, Grok, DeepSeek, or Gemini) to unlock auto-fix and remediation.
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

// ── MCP Section ───────────────────────────────────────────────────────────────

function McpSection() {
  const tools = [
    {
      name: "get_root_cause",
      desc: "Deep AI analysis of an alert — pulls Sentry stack traces, Vercel build logs, and GitHub CI output in parallel.",
    },
    {
      name: "trigger_fix",
      desc: "Full remediation pipeline: diagnose → read code → AI fix → self-review → push branch → wait CI → open PR.",
    },
    {
      name: "rollback_vercel",
      desc: "Instantly roll back to the last successful production deployment. No CLI flags needed.",
    },
    {
      name: "get_build_logs",
      desc: "Fetch Vercel build logs with automatic error extraction — ready to paste into a prompt.",
    },
    {
      name: "silence_alert",
      desc: "Mark an alert as resolved from inside your editor once you've handled it.",
    },
  ];

  const editors = [
    { name: "Claude Code", logo: "/editor-logos/claude-code.svg" },
    { name: "Cursor",      logo: "/editor-logos/cursor.svg" },
    { name: "Windsurf",    logo: "/editor-logos/windsurf.svg" },
  ];

  return (
    <section className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">

        {/* Header */}
        <div className="mb-14 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <div>
            <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">MCP Server</p>
            <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl max-w-lg">
              Your editor becomes the ops dashboard
            </h2>
            <p className="mt-4 text-fg-base max-w-md">
              InariWatch runs as an MCP server alongside your AI editor.
              Claude Code, Cursor, and Windsurf can query alerts, trigger fixes,
              and roll back deployments — without leaving your code.
            </p>
          </div>
          {/* Editor compatibility badges */}
          <div className="flex items-center gap-3 shrink-0">
            {editors.map((e) => (
              <div
                key={e.name}
                className="flex items-center gap-2 rounded-lg border border-inari-border bg-inari-card px-3 py-2 text-xs text-zinc-400"
              >
                <Code2 className="h-3.5 w-3.5 text-zinc-500" />
                {e.name}
              </div>
            ))}
            <div className="flex items-center gap-2 rounded-lg border border-inari-border bg-inari-card px-3 py-2 text-xs text-zinc-500">
              <Plug className="h-3.5 w-3.5" />
              + any MCP client
            </div>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">

          {/* Left: config snippet */}
          <div className="rounded-2xl border border-inari-border bg-inari-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-inari-border px-4 py-3">
              <div className="flex gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
              </div>
              <span className="text-xs text-zinc-500 font-mono ml-1">.mcp.json</span>
            </div>
            <pre className="p-5 text-sm font-mono leading-relaxed text-zinc-700 dark:text-zinc-300 overflow-x-auto">{`{
  "mcpServers": {
    "inariwatch": {
      "command": "inariwatch",
      "args": ["serve-mcp"]
    }
  }
}`}</pre>
            <div className="border-t border-inari-border px-5 py-4 bg-inari-bg/50">
              <p className="text-xs text-zinc-500 leading-relaxed">
                Drop this in your project root. The server starts automatically — no daemon, no ports.
                Works the same in Claude Code, Cursor, and Windsurf.
              </p>
            </div>
          </div>

          {/* Right: action tools list */}
          <div className="space-y-3">
            <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">5 action tools</p>
            {tools.map((t) => (
              <div
                key={t.name}
                className="flex gap-3 rounded-xl border border-inari-border bg-inari-card px-4 py-3 hover:border-inari-accent/30 transition-colors"
              >
                <div className="mt-0.5 shrink-0">
                  <Wand2 className="h-4 w-4 text-inari-accent/60" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-mono text-inari-accent font-medium">{t.name}</p>
                  <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{t.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 flex items-center gap-4">
          <Link href="/docs#cli-mcp" className="text-sm text-inari-accent hover:text-inari-accent/80 transition-colors flex items-center gap-1.5">
            Read the MCP docs
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <span className="text-zinc-700 text-sm">·</span>
          <Link href="/docs#cli-installation" className="text-sm text-zinc-500 hover:text-fg-strong dark:hover:text-zinc-300 transition-colors">
            Install the CLI
          </Link>
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
          <Link href="/trust" className="hover:text-fg-base transition-colors">Trust</Link>
          <Link href="/blog" className="hover:text-fg-base transition-colors">Blog</Link>
          <a href="https://github.com/orbita-pos/inariwatch" target="_blank" rel="noopener noreferrer" className="hover:text-fg-base transition-colors">GitHub</a>
          <Link href="/privacy" className="hover:text-fg-base transition-colors">Privacy</Link>
          <Link href="/terms" className="hover:text-fg-base transition-colors">Terms</Link>
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
        <DemoVideo />
        <StatsBar />
        <RemediationWalkthrough />
        <AutoMergeSafety />
        <WhyNotNative />
        <Integrations />
        <AIFeatures />
        <McpSection />
      </main>
      <Footer />
    </div>
  );
}
