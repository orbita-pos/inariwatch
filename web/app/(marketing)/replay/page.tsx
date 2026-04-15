import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  Play,
  Sparkles,
  GitPullRequest,
  Activity,
  MousePointerClick,
  Gauge,
  ShieldCheck,
  Eye,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "../marketing-nav";
import { ReplayDemo } from "./replay-demo";

const PAGE_TITLE       = "Session Replay — InariWatch";
const PAGE_DESCRIPTION = "AI-narrated session replay that turns user frustration into a pull request. Rage clicks, dead clicks, Web Vitals, console, network — and one click to generate the fix.";
const PAGE_URL         = "https://inariwatch.com/replay";

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
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

// ── Hero ──────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="absolute inset-x-0 top-0 h-[640px] pointer-events-none"
        style={{ background: "radial-gradient(ellipse 60% 50% at 30% 0%, rgba(249,115,22,0.14) 0%, transparent 70%)" }}
        aria-hidden
      />
      <div
        className="absolute inset-0 pointer-events-none bg-grid"
        style={{
          maskImage: "radial-gradient(ellipse 80% 55% at 30% 0%, black 0%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 55% at 30% 0%, black 0%, transparent 100%)",
        }}
        aria-hidden
      />

      <div className="relative pt-32 pb-20 sm:pt-40 sm:pb-24 mx-auto max-w-6xl px-6 text-center">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-4 py-1.5">
          <Sparkles className="h-3.5 w-3.5 text-inari-accent" aria-hidden="true" />
          <span className="text-xs font-mono text-inari-accent tracking-wide">NEW · SESSION REPLAY</span>
        </div>

        <h1 className="text-[48px] sm:text-[64px] lg:text-[72px] font-semibold tracking-[-0.04em] text-fg-strong leading-[0.96] max-w-4xl mx-auto">
          Watch the bug.<br />
          <span className="text-gradient-accent">Generate the fix.</span>
        </h1>

        <p className="mt-7 text-[17px] text-fg-base max-w-2xl mx-auto leading-relaxed">
          Replay every user session — DOM, console, network, Web Vitals, frustration signals — then
          click <span className="font-semibold text-fg-strong">Generate Fix</span> and ship a pull
          request without touching the keyboard.
        </p>

        <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link href="/register">
            <Button variant="primary" size="lg" className="min-w-[168px]">
              Start free <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
          <Link href="#how">
            <Button variant="ghost" size="lg" className="min-w-[168px]">
              <Play className="mr-1.5 h-4 w-4" /> See how it works
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

// ── Differentiators strip ─────────────────────────────────────────────────────

function DifferentiatorsStrip() {
  const items = [
    { icon: Sparkles,         label: "AI-narrated chapters" },
    { icon: GitPullRequest,   label: "Generate-Fix from any session" },
    { icon: Activity,         label: "Substrate I/O sync" },
    { icon: Gauge,            label: "Web Vitals on the timeline" },
    { icon: MousePointerClick,label: "Rage + dead-click detection" },
  ];
  return (
    <section className="border-y border-inari-border py-10">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-[10px] font-mono uppercase tracking-[0.18em] text-fg-base/60 mb-7">
          Replay is one stream — your whole stack on one timeline
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-9 gap-y-4 text-fg-base">
          {items.map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-2 opacity-80 hover:opacity-100 transition-opacity">
              <Icon className="h-4 w-4 text-inari-accent shrink-0" aria-hidden="true" />
              <span className="text-sm font-medium">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Mock player preview ───────────────────────────────────────────────────────

function PlayerPreview() {
  return (
    <section className="py-20 sm:py-24">
      <div className="mx-auto max-w-5xl px-6">
        <div className="mx-auto max-w-2xl text-center mb-12">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-4">Try it</p>
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-fg-strong">
            Press play. Watch a session unfold.
          </h2>
          <p className="mt-4 text-fg-base">
            Real interactions — scrub the timeline, switch tabs, click Generate Fix.
            No video, no recording — built from the same primitives as the live player.
          </p>
        </div>

        <ReplayDemo />
      </div>
    </section>
  );
}


// ── Three pillars ─────────────────────────────────────────────────────────────

function Pillars() {
  const pillars = [
    {
      icon: <Eye className="h-5 w-5" />,
      title: "See exactly what they saw",
      body: "DOM replay synced with console, network, navigation — and Substrate I/O when the SDK is on. PII masked by default.",
    },
    {
      icon: <MousePointerClick className="h-5 w-5" />,
      title: "Surface the frustration",
      body: "Rage clicks, dead clicks, slow Web Vitals — auto-detected and ranked. Filter the list to sessions that actually matter.",
    },
    {
      icon: <GitPullRequest className="h-5 w-5" />,
      title: "Ship the fix",
      body: "Click Generate Fix. AI reads the trace, the replay, and your code, then opens a PR with 11 safety gates already passing.",
    },
  ];
  return (
    <section className="py-20 border-y border-inari-border bg-inari-card/30">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid md:grid-cols-3 gap-px bg-inari-border">
          {pillars.map((p) => (
            <div key={p.title} className="bg-inari-bg p-8">
              <div className="h-9 w-9 rounded-lg bg-inari-accent/10 text-inari-accent flex items-center justify-center mb-5">
                {p.icon}
              </div>
              <h3 className="text-base font-semibold text-fg-strong mb-2.5">{p.title}</h3>
              <p className="text-sm text-fg-base leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Comparison table ──────────────────────────────────────────────────────────

function Comparison() {
  type CellValue = boolean | "partial" | "split";
  const rows: Array<{ feature: string; us: CellValue; sentry: CellValue; logrocket: CellValue; datadog: CellValue }> = [
    { feature: "DOM replay",                     us: true,  sentry: true,  logrocket: true,  datadog: true },
    { feature: "Console + network panels",       us: true,  sentry: true,  logrocket: true,  datadog: true },
    { feature: "Web Vitals on the timeline",     us: true,  sentry: "split", logrocket: true, datadog: true },
    { feature: "Rage / dead-click detection",    us: true,  sentry: "partial", logrocket: true, datadog: false },
    { feature: "AI-narrated chapters",           us: true,  sentry: false, logrocket: false, datadog: false },
    { feature: "Backend I/O on the same timeline", us: true, sentry: false, logrocket: false, datadog: false },
    { feature: "One-click PR from a replay",     us: true,  sentry: false, logrocket: false, datadog: false },
  ];

  function Cell({ value }: { value: CellValue }) {
    if (value === true) return <Check className="h-4 w-4 text-emerald-500 mx-auto" aria-label="Yes" />;
    if (value === false) return <X className="h-4 w-4 text-fg-base/30 mx-auto" aria-label="No" />;
    return <span className="text-[11px] font-mono text-fg-base/60">{value}</span>;
  }

  return (
    <section className="py-20 sm:py-24">
      <div className="mx-auto max-w-4xl px-6">
        <div className="text-center mb-12">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-4">vs. the rest</p>
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-fg-strong">
            Replay parity. Plus three things nobody else does.
          </h2>
        </div>

        <div className="rounded-xl border border-inari-border bg-inari-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-inari-border bg-surface-dim">
                <th className="text-left font-medium text-fg-base/70 px-5 py-3 text-xs uppercase tracking-wide">Feature</th>
                <th className="font-semibold text-inari-accent px-3 py-3 text-xs uppercase tracking-wide">InariWatch</th>
                <th className="font-medium text-fg-base/70 px-3 py-3 text-xs uppercase tracking-wide">Sentry</th>
                <th className="font-medium text-fg-base/70 px-3 py-3 text-xs uppercase tracking-wide">LogRocket</th>
                <th className="font-medium text-fg-base/70 px-3 py-3 text-xs uppercase tracking-wide">Datadog</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.feature} className="border-b border-inari-border last:border-b-0">
                  <td className="text-fg-strong px-5 py-3">{r.feature}</td>
                  <td className="text-center px-3 py-3 bg-inari-accent/[0.04]"><Cell value={r.us} /></td>
                  <td className="text-center px-3 py-3"><Cell value={r.sentry} /></td>
                  <td className="text-center px-3 py-3"><Cell value={r.logrocket} /></td>
                  <td className="text-center px-3 py-3"><Cell value={r.datadog} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-center text-xs text-fg-base/60">
          Compared 2026-04. Things change — if a competitor ships parity, we&rsquo;ll update this table.
        </p>
      </div>
    </section>
  );
}

// ── How it works ──────────────────────────────────────────────────────────────

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Drop in the SDK",
      body: "Two lines. Zero config. Records DOM, console, network, navigation, Web Vitals, and errors.",
      code: `import { initReplay } from "@inariwatch/capture-replay";\ninitReplay({ projectId: "your-project-id" });`,
    },
    {
      n: "02",
      title: "Sessions auto-correlate",
      body: "Every replay with an error gets linked to an alert (or creates one). Frustration signals surface to the top of the list.",
      code: `// optional — identify the user\nwindow.__INARIWATCH_USER__ = {\n  id:    user.id,\n  email: user.email,\n};`,
    },
    {
      n: "03",
      title: "Click Generate Fix",
      body: "AI reads the replay + the alert + your code, runs 11 safety gates, opens a PR. Auto-merge if every gate is green.",
      code: `→ Diagnose → Read code → Generate fix → Self-review\n→ Security scan → Substrate replay → Staging E2E\n→ Open PR → Auto-merge → Watch for regressions`,
    },
  ];

  return (
    <section id="how" className="py-24 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center mb-16">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-4">How it works</p>
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-fg-strong">
            From install to merged PR.
          </h2>
        </div>

        <div className="space-y-10">
          {steps.map((s, i) => (
            <div key={s.n} className="grid md:grid-cols-[140px_1fr_1.2fr] gap-6 md:gap-10 items-start">
              <div>
                <p className="text-[10px] font-mono text-fg-base/50 tracking-[0.2em] uppercase">Step</p>
                <p className="text-5xl font-semibold tracking-tight text-fg-strong">{s.n}</p>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-fg-strong mb-2">{s.title}</h3>
                <p className="text-sm text-fg-base leading-relaxed">{s.body}</p>
              </div>
              <pre className="rounded-xl border border-inari-border bg-[#0a0a0c] p-4 overflow-x-auto font-mono text-[12px] leading-relaxed text-white/80">
                <code>{s.code}</code>
              </pre>
              {i < steps.length - 1 && (
                <div className="md:col-span-3 border-b border-inari-border" />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Privacy / trust strip ─────────────────────────────────────────────────────

function PrivacyStrip() {
  const items = [
    { title: "PII masked by default", body: "Inputs, passwords, and labelled blocks are blocked from capture before they ever leave the browser." },
    { title: "Per-project retention", body: "Configurable from 1 to 366 days. Daily cron sweeps expired sessions out of R2 and the database." },
    { title: "End-user emails optional", body: "Opt-in hashing per project. We never scrape the DOM — you set the user contract explicitly." },
    { title: "Workspace-scoped", body: "Replay is gated per organization. Personal workspaces never see other tenants&rsquo; sessions." },
  ];
  return (
    <section className="py-20 border-t border-inari-border bg-inari-card/30">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex items-center gap-3 mb-8">
          <ShieldCheck className="h-5 w-5 text-inari-accent" aria-hidden="true" />
          <h2 className="text-xl font-bold text-fg-strong">Built privacy-first</h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {items.map((it) => (
            <div key={it.title} className="rounded-xl border border-inari-border bg-inari-card p-5">
              <h3 className="text-sm font-semibold text-fg-strong mb-2">{it.title}</h3>
              <p className="text-xs text-fg-base leading-relaxed" dangerouslySetInnerHTML={{ __html: it.body }} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── CTA ───────────────────────────────────────────────────────────────────────

function CTA() {
  return (
    <section className="py-20 border-t border-inari-border">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-fg-strong">
          Stop guessing what broke.
        </h2>
        <p className="mt-5 text-fg-base max-w-xl mx-auto">
          Install the SDK, record one session, and let InariWatch open the PR.
          Free while in beta — no credit card.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link href="/register">
            <Button variant="primary" size="lg" className="min-w-[168px]">
              Start free <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
          <Link href="/docs">
            <Button variant="ghost" size="lg" className="min-w-[168px]">
              Read the docs
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-inari-border py-12">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <Image src="/logo-inari/favicon-96x96.png" alt="" width={24} height={24} />
            <span className="font-mono text-sm text-fg-base">inariwatch · built in MX</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fg-base">
            <Link href="/docs"     className="hover:text-fg-strong transition-colors">Docs</Link>
            <Link href="/pricing"  className="hover:text-fg-strong transition-colors">Pricing</Link>
            <Link href="/network"  className="hover:text-fg-strong transition-colors">Network</Link>
            <Link href="/trust"    className="hover:text-fg-strong transition-colors">Trust</Link>
            <Link href="/status"   className="hover:text-fg-strong transition-colors">Status</Link>
            <Link href="/blog"     className="hover:text-fg-strong transition-colors">Blog</Link>
            <a
              href="https://github.com/orbita-pos/inariwatch-capture"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg-strong transition-colors"
            >
              GitHub
            </a>
            <Link href="/privacy"  className="hover:text-fg-strong transition-colors">Privacy</Link>
            <Link href="/terms"    className="hover:text-fg-strong transition-colors">Terms</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function ReplayPage() {
  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav opaque />
      <main>
        <Hero />
        <DifferentiatorsStrip />
        <PlayerPreview />
        <Pillars />
        <Comparison />
        <HowItWorks />
        <PrivacyStrip />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
