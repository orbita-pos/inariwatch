import Link from "next/link";
import Image from "next/image";
import {
  GitHubIcon, VercelIcon, SentryIcon, PostgreSQLIcon, NpmIcon, UptimeIcon, DatadogIcon, ExpoIcon,
} from "@/components/brand-icons";
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
  TestTube2,
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
              <Link href="/download" className="flex items-center gap-1.5 hover:text-white transition-colors">
                <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" />
                Mobile app available
              </Link>
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
    { value: "9", label: "integrations monitored" },
    { value: "25", label: "MCP tools" },
    { value: "11", label: "safety gates" },
    { value: "10/10", label: "stress tests passing" },
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

        {/* Steps — horizontal breadcrumb */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-10 rounded-xl border border-inari-border bg-inari-card px-6 py-4">
          {steps.map((step, i) => (
            <span key={step.n} className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-inari-accent/10 text-inari-accent text-xs font-bold">{step.n}</span>
              <span className="text-sm font-medium text-fg-strong">{step.title}</span>
              {i < steps.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-zinc-600 mx-1" />}
            </span>
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
      label: "CI + regression tests pass",
      detail: "Existing tests + AI-generated regression test must all pass",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "Confidence ≥ threshold",
      detail: "Diagnosis must be clear — low-confidence fixes become draft PRs",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "AI self-review ≥ 70/100",
      detail: "A second AI reviews the fix like a senior engineer",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "Security scan clean",
      detail: "ESLint + pattern scan — zero HIGH severity findings",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "Substrate replay verified",
      detail: "Fix verified against the recorded I/O that caused the crash",
    },
    {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "E2E staging passed",
      detail: "Playwright tests pass against the app running with the fix",
    },
  ];

  return (
    <section className="py-20 border-t border-inari-border bg-inari-card/20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-10 max-w-xl">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">
            Auto-merge
          </p>
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl leading-tight">
            You sleep. We ship.{" "}
            <span className="text-inari-accent">Safely.</span>
          </h2>
          <p className="mt-4 text-fg-base leading-relaxed">
            11 safety gates — CI, regression tests, confidence, self-review, security scan, Substrate replay, E2E staging, and more — all must pass. Off by default.
          </p>
        </div>

        <div className="max-w-2xl mx-auto space-y-4">
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
            { cap: "Writes code fix + regression test", dd: false, us: true },
            { cap: "Code Intelligence (AST + embeddings + dependency graph)", dd: false, us: true },
            { cap: "11 safety gates + E2E staging verification", dd: false, us: true },
            { cap: "Substrate I/O replay verification", dd: false, us: true },
            { cap: "Community fix network (crowdsourced)", dd: false, us: true },
            { cap: "MCP server (25 tools for AI editors)", dd: false, us: true },
            { cap: "Self-capture SDK (@inariwatch/capture)", dd: false, us: true },
            { cap: "Fully open source (MIT)", dd: false, us: true },
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
  const integrations: { name: string; icon: React.ReactNode }[] = [
    { name: "GitHub", icon: <GitHubIcon className="h-5 w-5" /> },
    { name: "Vercel", icon: <VercelIcon className="h-5 w-5" /> },
    { name: "Sentry", icon: <SentryIcon className="h-5 w-5" /> },
    { name: "Datadog", icon: <DatadogIcon className="h-5 w-5" /> },
    { name: "Expo", icon: <ExpoIcon className="h-5 w-5" /> },
    { name: "PostgreSQL", icon: <PostgreSQLIcon className="h-5 w-5" /> },
    { name: "Uptime", icon: <UptimeIcon className="h-5 w-5" /> },
    { name: "npm / Cargo", icon: <NpmIcon className="h-5 w-5" /> },
    { name: "Capture SDK", icon: <Zap className="h-5 w-5 text-inari-accent" /> },
  ];

  return (
    <section id="integrations" className="py-16 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="text-center mb-10">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">9 Integrations</p>
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl">
            Monitors your entire stack
          </h2>
          <p className="mt-3 text-fg-base max-w-lg mx-auto">
            All signals correlated into one brain. When Vercel fails and Sentry spikes at the same time, you get one alert — not three.
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-3">
          {integrations.map((item) => (
            <div
              key={item.name}
              className="flex items-center gap-2 rounded-full border border-inari-border bg-inari-card px-4 py-2 hover:border-inari-accent/30 transition-all"
            >
              <span className="shrink-0 text-zinc-400">{item.icon}</span>
              <span className="text-sm font-medium text-fg-strong whitespace-nowrap">{item.name}</span>
            </div>
          ))}
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
      body: "Reads your repo, writes the fix + regression test, pushes a branch, waits for CI, retries up to 3x. 11 safety gates before auto-merge.",
      tag: "Unique",
    },
    {
      icon: <Brain className="h-5 w-5" />,
      title: "Code Intelligence",
      body: "Tree-sitter AST + Voyage Code 3 embeddings + dependency graph. The AI knows your codebase — fixes match your conventions, not generic patterns.",
      tag: "Code RAG",
    },
    {
      icon: <TestTube2 className="h-5 w-5" />,
      title: "Regression Test Generation",
      body: "Every fix ships with an AI-generated test that reproduces the bug. If the test fails, the fix is bad — retry automatically.",
      tag: "Verification",
    },
    {
      icon: <Zap className="h-5 w-5" />,
      title: "Community Fix Network",
      body: "When a fix passes CI and gets approved, the pattern joins the network. Next team with the same error gets an instant, proven fix.",
      tag: "Network effect",
    },
    {
      icon: <Shield className="h-5 w-5" />,
      title: "Auto-Heal + E2E Staging",
      body: "Site goes down? Rollback in 30s, fix in background. E2E tests run against the fix in GitHub Actions before merge.",
      tag: "Self-healing",
    },
    {
      icon: <Hash className="h-5 w-5" />,
      title: "Slack & Telegram Bot",
      body: "14 commands, Fix It button, AI diagnosis, on-call management, deploy monitoring — all in-thread.",
      tag: "Control surface",
    },
    {
      icon: <GitPullRequest className="h-5 w-5" />,
      title: "Pre-deploy Risk Assessment",
      body: "AI reads every PR diff against your incident history and posts a risk score on GitHub before you merge.",
      tag: "Prevention",
    },
    {
      icon: <MessageSquare className="h-5 w-5" />,
      title: "Ask Inari",
      body: "\"What broke yesterday?\" Chat with your live monitoring data. Inari has full context — alerts, remediations, uptime.",
      tag: "Ops copilot",
    },
  ];

  return (
    <section id="features" className="py-20 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-10 text-center">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Platform</p>
          <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl">
            Not just monitoring. Automated fixing.
          </h2>
          <p className="mt-3 text-fg-base max-w-lg mx-auto">
            AI analysis included free. Bring your own key (Claude, OpenAI, Groq, Grok, DeepSeek, Gemini) for auto-fix.
          </p>
        </div>

        {/* Hero card — AI Remediation (the main feature) */}
        <div className="mb-4 group rounded-xl border border-inari-accent/30 bg-inari-accent-dim p-8 transition-all hover:border-inari-accent/50 hover:shadow-[0_0_30px_rgba(124,58,237,0.1)]">
          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-inari-accent/30 bg-inari-accent/10 text-inari-accent">
              {features[0].icon}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="text-xl font-bold text-fg-strong">{features[0].title}</h3>
                <span className="text-xs font-mono px-2 py-0.5 rounded-full text-inari-accent bg-inari-accent/10 border border-inari-accent/20">
                  {features[0].tag}
                </span>
              </div>
              <p className="text-fg-base leading-relaxed">{features[0].body}</p>
            </div>
          </div>
        </div>

        {/* Remaining features — grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.slice(1).map((f) => (
            <div
              key={f.title}
              className="group rounded-xl border border-inari-accent/20 bg-inari-accent-dim p-6 transition-all hover:border-inari-accent/40 hover:shadow-[0_0_24px_rgba(124,58,237,0.07)]"
            >
              <div className="mb-4 flex items-center justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-inari-accent/30 bg-inari-accent/10 text-inari-accent">
                  {f.icon}
                </div>
                <span className="text-xs font-mono px-2 py-0.5 rounded-full text-inari-accent bg-inari-accent/10 border border-inari-accent/20">
                  {f.tag}
                </span>
              </div>
              <h3 className="font-semibold text-fg-strong mb-2">{f.title}</h3>
              <p className="text-sm text-fg-base leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link href="/docs#features" className="text-sm text-inari-accent hover:text-inari-accent/80 transition-colors">
            See all 14 features — on-call, uptime, anomaly detection, incident storms, and more
            <ArrowRight className="inline ml-1 h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

// ── MCP Section ───────────────────────────────────────────────────────────────

function McpSection() {
  const highlights = [
    {
      name: "ask_inari",
      desc: "Ask natural language questions about your infrastructure. \"What broke yesterday?\" — Inari has the full context.",
    },
    {
      name: "trigger_fix",
      desc: "Full AI remediation: diagnose → read code → generate fix → self-review → push → CI → PR. Streams progress in real time.",
    },
    {
      name: "get_root_cause",
      desc: "Deep root cause analysis pulling Sentry stack traces, Vercel build logs, GitHub CI, and Substrate I/O recordings.",
    },
    {
      name: "rollback_vercel",
      desc: "Instantly roll back to the last successful production deployment. One command.",
    },
  ];

  const editors = ["Claude Code", "Cursor", "Windsurf", "VS Code Copilot", "Codex CLI", "Gemini CLI"];

  return (
    <section className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">

        {/* Header */}
        <div className="mb-14 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <div>
            <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">MCP Server</p>
            <h2 className="text-3xl font-bold text-fg-strong sm:text-4xl max-w-lg">
              Your AI already knows what&apos;s broken
            </h2>
            <p className="mt-4 text-fg-base max-w-md">
              One command connects InariWatch to any AI coding tool.
              25 tools, 4 live data resources, 7 prompt workflows — your AI gets
              full production context before you even ask.
            </p>
          </div>
          {/* Editor compatibility badges */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {editors.map((e) => (
              <div
                key={e}
                className="flex items-center gap-2 rounded-lg border border-inari-border bg-inari-card px-3 py-2 text-xs text-zinc-400"
              >
                <Code2 className="h-3.5 w-3.5 text-zinc-500" />
                {e}
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">

          {/* Left: setup snippet */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-inari-accent/25 bg-inari-card overflow-hidden shadow-[0_0_60px_rgba(124,58,237,0.06)]">
              <div className="flex items-center gap-2 border-b border-inari-border px-4 py-3">
                <div className="flex gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
                </div>
                <span className="text-xs text-zinc-500 font-mono ml-1">terminal</span>
              </div>
              <div className="p-5 font-mono text-sm leading-7">
                <p className="text-zinc-500 text-xs mb-3"># One command. Everything configured.</p>
                <p><span className="text-inari-accent select-none">$ </span><span className="text-zinc-200">npx @inariwatch/mcp init</span></p>
                <br />
                <p className="text-zinc-600">  ✓ Claude Code configured</p>
                <p className="text-zinc-600">  ✓ Cursor configured</p>
                <p className="text-zinc-600">  ✓ @inariwatch/capture installed</p>
                <p className="text-zinc-600">  ✓ Substrate I/O enabled</p>
                <p className="text-zinc-600">  ✓ GitHub linked (via gh CLI)</p>
                <br />
                <p className="text-inari-accent">  Done! MCP + Capture + Substrate ready.</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg border border-inari-border bg-inari-card p-3">
                <p className="text-2xl font-bold text-fg-strong font-mono">21</p>
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mt-0.5">tools</p>
              </div>
              <div className="rounded-lg border border-inari-border bg-inari-card p-3">
                <p className="text-2xl font-bold text-fg-strong font-mono">4</p>
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mt-0.5">resources</p>
              </div>
              <div className="rounded-lg border border-inari-border bg-inari-card p-3">
                <p className="text-2xl font-bold text-fg-strong font-mono">7</p>
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mt-0.5">prompts</p>
              </div>
            </div>
          </div>

          {/* Right: highlight tools */}
          <div className="space-y-3">
            <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">Highlight tools</p>
            {highlights.map((t) => (
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
          <Link href="/docs#mcp-overview" className="text-sm text-inari-accent hover:text-inari-accent/80 transition-colors flex items-center gap-1.5">
            MCP docs — all 25 tools
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <span className="text-zinc-700 text-sm">·</span>
          <Link href="/docs#mcp-setup" className="text-sm text-zinc-500 hover:text-fg-strong dark:hover:text-zinc-300 transition-colors">
            Setup guide
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
          <Link href="/download" className="hover:text-fg-base transition-colors">Mobile App</Link>
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
        <Integrations />
        <AIFeatures />
        <McpSection />
        <WhyNotNative />
      </main>
      <Footer />
    </div>
  );
}
