export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { db, blogPosts, errorPatterns, communityFixes, fixRatings } from "@/lib/db";
import { eq, desc, sql } from "drizzle-orm";

const LANDING_TITLE       = "InariWatch — AI Monitoring That Fixes Your Code";
const LANDING_DESCRIPTION = "Your CI broke. The PR is already open. InariWatch monitors GitHub, Vercel, Sentry and more — then writes the fix autonomously.";

export const metadata: Metadata = {
  title:       LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  alternates:  { canonical: "https://inariwatch.com" },
  openGraph: {
    type:        "website",
    url:         "https://inariwatch.com",
    siteName:    "InariWatch",
    title:       LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    // images auto-resolved from app/opengraph-image.tsx
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    // images auto-resolved from app/opengraph-image.tsx
  },
};

type LatestPost = { slug: string; title: string } | null;

import {
  GitHubIcon, VercelIcon, SentryIcon, PostgreSQLIcon, NpmIcon, UptimeIcon, DatadogIcon, ExpoIcon, CloudflareIcon,
  NextjsIcon, RemixIcon, BunIcon, FastifyIcon, ExpressIcon,
  ClaudeIcon, CursorIcon, WindsurfIcon, VSCodeIcon, CodexIcon, GeminiIcon, OpenClawIcon,
} from "@/components/brand-icons";
import { ArrowRight, CheckCircle2, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InstallSnippet } from "./install-snippet";
import { MarketingNav } from "./marketing-nav";
import { DemoVideo } from "./demo-video";
import { MiniDashboard } from "./mini-dashboard";

// ── Latest blog pill ──────────────────────────────────────────────────────────

function LatestBlogPill({ post }: { post: { slug: string; title: string } }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group inline-flex items-center gap-3 rounded-full border border-inari-border bg-inari-card py-1 pl-1 pr-4 hover:border-inari-accent/40 transition-colors"
    >
      <span className="rounded-full bg-inari-accent px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
        New
      </span>
      <span className="text-sm text-fg-strong truncate max-w-[220px] sm:max-w-[360px]">
        {post.title}
      </span>
      <ArrowRight className="h-3.5 w-3.5 text-fg-base transition-all group-hover:text-inari-accent group-hover:translate-x-0.5" />
    </Link>
  );
}

function BetaPill() {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-inari-border bg-inari-card px-3 py-1">
      <span className="h-1.5 w-1.5 rounded-full bg-inari-accent animate-pulse" />
      <span className="text-xs font-mono text-fg-base">
        Now in beta — <span className="text-fg-strong">free full access</span>
      </span>
    </div>
  );
}


// ── Hero ──────────────────────────────────────────────────────────────────────

function Hero({ latestPost }: { latestPost: LatestPost }) {
  return (
    <section className="relative overflow-hidden">
      {/* Orange glow — biased left where the text lives */}
      <div
        className="absolute inset-x-0 top-0 h-[640px] pointer-events-none"
        style={{ background: "radial-gradient(ellipse 60% 50% at 30% 0%, rgba(249,115,22,0.14) 0%, transparent 70%)" }}
        aria-hidden
      />
      {/* Grid */}
      <div
        className="absolute inset-0 pointer-events-none bg-grid"
        style={{
          maskImage: "radial-gradient(ellipse 80% 55% at 30% 0%, black 0%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 55% at 30% 0%, black 0%, transparent 100%)",
        }}
        aria-hidden
      />

      <div className="relative pt-24 pb-20 sm:pt-32 sm:pb-24 mx-auto max-w-6xl px-6">
        <div className="flex flex-col lg:grid lg:grid-cols-[1fr_1.15fr] lg:gap-12 lg:items-center">

          {/* ── Left: text ── */}
          <div className="text-center lg:text-left">

            <div className="mb-7 flex justify-center lg:justify-start" style={{ animation: "card-in 0.5s ease 0.05s both" }}>
              {latestPost ? <LatestBlogPill post={latestPost} /> : <BetaPill />}
            </div>

            <h1
              className="text-[52px] sm:text-[64px] lg:text-[64px] xl:text-[72px] font-semibold tracking-[-0.04em] text-fg-strong leading-[0.94]"
              style={{ animation: "card-in 0.6s ease 0.15s both" }}
            >
              Monitoring that<br />
              <span className="text-gradient-accent">fixes itself.</span>
            </h1>

            <p
              className="mt-6 text-[16px] text-fg-base max-w-[380px] mx-auto lg:mx-0 leading-relaxed"
              style={{ animation: "card-in 0.5s ease 0.3s both" }}
            >
              When something breaks, AI reads your code, writes the fix, and opens a PR.
              CI passes. You approve.
            </p>

            <div
              className="mt-8 flex flex-col sm:flex-row items-center lg:items-start justify-center lg:justify-start gap-3"
              style={{ animation: "card-in 0.5s ease 0.42s both" }}
            >
              <Link href="/register">
                <Button variant="primary" size="lg" className="min-w-[148px]">
                  Start free <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
              <Link href="#how">
                <Button variant="ghost" size="lg" className="min-w-[148px]">
                  See how it works
                </Button>
              </Link>
            </div>

          </div>

          {/* ── Right: dashboard ── */}
          <div
            className="hidden lg:block"
            style={{ animation: "card-in 0.8s ease 0.35s both" }}
          >
            <MiniDashboard />
          </div>

        </div>
      </div>
    </section>
  );
}

// ── Works with any runtime ────────────────────────────────────────────────────

const FRAMEWORK_ICONS = [
  { label: "Next.js",  icon: NextjsIcon  },
  { label: "Remix",    icon: RemixIcon   },
  { label: "Express",  icon: ExpressIcon },
  { label: "Fastify",  icon: FastifyIcon },
  { label: "Bun",      icon: BunIcon     },
];

function RuntimeStrip() {
  return (
    <section className="py-14">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-[10px] font-mono uppercase tracking-[0.18em] text-fg-base/60 mb-8">
          Drop-in SDK for Node &amp; TypeScript
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
          {FRAMEWORK_ICONS.map(({ label, icon: Icon }) => (
            <div key={label} className="flex flex-col items-center gap-2 group">
              <Icon className="h-6 w-6 text-fg-base/55 group-hover:text-fg-base/80 transition-colors duration-200" />
              <span className="text-[10px] font-medium text-fg-base/55 group-hover:text-fg-base/80 transition-colors duration-200 tracking-wide">
                {label}
              </span>
            </div>
          ))}
        </div>
        <p className="text-center text-[11px] text-fg-base/70 mt-6 max-w-md mx-auto">
          Monitoring any other language? The InariWatch Agent watches Python, Go, Rust and anything else — zero code changes.
        </p>
      </div>
    </section>
  );
}

// ── Quick install ─────────────────────────────────────────────────────────────

function QuickInstall() {
  return (
    <section className="pb-20">
      <div className="mx-auto max-w-2xl px-6">
        <InstallSnippet />
      </div>
    </section>
  );
}

// ── Integration logos row ─────────────────────────────────────────────────────

function TrustedBy() {
  const items = [
    {
      name: "Capture",
      icon: (
        <Image
          src="/logo-inari/favicon-96x96.png"
          alt=""
          width={20}
          height={20}
          className="h-5 w-5 shrink-0"
        />
      ),
    },
    { name: "GitHub", icon: <GitHubIcon className="h-5 w-5" /> },
    { name: "Vercel", icon: <VercelIcon className="h-5 w-5" /> },
    { name: "Sentry", icon: <SentryIcon className="h-5 w-5" /> },
    { name: "Datadog", icon: <DatadogIcon className="h-5 w-5" /> },
    { name: "Expo", icon: <ExpoIcon className="h-5 w-5" /> },
    { name: "PostgreSQL", icon: <PostgreSQLIcon className="h-5 w-5" /> },
    { name: "Uptime", icon: <UptimeIcon className="h-5 w-5" /> },
    { name: "npm", icon: <NpmIcon className="h-5 w-5" /> },
    { name: "Cloudflare", icon: <CloudflareIcon className="h-5 w-5" /> },
  ];

  return (
    <section className="border-y border-inari-border py-14">
      <div className="mx-auto max-w-6xl px-6">
        <p className="text-center text-xs font-mono uppercase tracking-widest text-fg-base mb-10">
          Watches your entire stack
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-6 text-fg-base">
          {items.map((item) => (
            <div
              key={item.name}
              className="flex items-center gap-2 opacity-70 hover:opacity-100 transition-opacity"
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="text-sm font-medium">{item.name}</span>
            </div>
          ))}
          <div className="flex items-center opacity-70">
            <span className="text-sm font-mono font-medium">10+</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── How it works (3 steps) ────────────────────────────────────────────────────

// Fig 1 — Signal convergence: 6 sources → 1 unified alert
function FigConvergence() {
  const sources: Array<{ x: number; y: number; edge: [number, number]; hex: [number, number] }> = [
    { x: 270, y: 160, edge: [258, 160],      hex: [182, 160] },
    { x: 215, y: 255, edge: [209, 244.64],   hex: [171, 179] },
    { x: 105, y: 255, edge: [111, 244.64],   hex: [149, 179] },
    { x: 50,  y: 160, edge: [62, 160],       hex: [138, 160] },
    { x: 105, y: 65,  edge: [111, 75.36],    hex: [149, 141] },
    { x: 215, y: 65,  edge: [209, 75.36],    hex: [171, 141] },
  ];

  return (
    <svg
      viewBox="0 0 320 320"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-full h-full"
    >
      {/* Outer pulse rings — signal correlation field */}
      <circle cx="160" cy="160" r="82" opacity="0.15" strokeDasharray="2 5" />
      <circle cx="160" cy="160" r="60" opacity="0.25" strokeDasharray="2 4" />
      <circle cx="160" cy="160" r="40" opacity="0.4" />

      {/* Dashed signal paths flowing from sources toward center */}
      {sources.map((s, i) => (
        <line
          key={i}
          x1={s.edge[0]}
          y1={s.edge[1]}
          x2={s.hex[0]}
          y2={s.hex[1]}
          opacity="0.6"
          strokeDasharray="3 3"
        />
      ))}

      {/* Center hexagon — the unified alert */}
      <path d="M185 160 L172.5 181.65 L147.5 181.65 L135 160 L147.5 138.35 L172.5 138.35 Z" />
      {/* Exclamation mark inside hex */}
      <line x1="160" y1="150" x2="160" y2="163" strokeWidth="1.6" />
      <circle cx="160" cy="169" r="1.4" fill="currentColor" />

      {/* 6 source nodes */}
      {sources.map((s, i) => (
        <g key={i}>
          <circle cx={s.x} cy={s.y} r="13" />
          <circle cx={s.x} cy={s.y} r="2.5" fill="currentColor" opacity="0.85" />
        </g>
      ))}
    </svg>
  );
}

// Fig 2 — Code diff: AI reads stack trace and writes fix
function FigDiff() {
  return (
    <svg
      viewBox="0 0 320 320"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-full h-full"
    >
      {/* Back panel — "before" with the bug */}
      <g opacity="0.45">
        <rect x="35" y="45" width="200" height="195" rx="4" />
        {/* Title bar */}
        <line x1="35" y1="68" x2="235" y2="68" />
        <circle cx="49" cy="56" r="2" />
        <circle cx="59" cy="56" r="2" />
        <circle cx="69" cy="56" r="2" />
        {/* Line-number gutter */}
        <line x1="68" y1="68" x2="68" y2="240" opacity="0.6" />
        {/* Code lines */}
        <line x1="82" y1="88"  x2="170" y2="88"  />
        <line x1="82" y1="102" x2="205" y2="102" />
        <line x1="90" y1="116" x2="180" y2="116" />
        {/* Bug row with "−" gutter mark */}
        <line x1="52" y1="130" x2="62"  y2="130" strokeWidth="1.6" />
        <line x1="82" y1="130" x2="215" y2="130" strokeWidth="1.4" />
        <line x1="90" y1="144" x2="158" y2="144" />
        <line x1="82" y1="158" x2="190" y2="158" />
        <line x1="82" y1="172" x2="150" y2="172" />
        {/* Stack-trace tail (dashed) */}
        <line x1="82" y1="190" x2="195" y2="190" opacity="0.5" strokeDasharray="2 2" />
        <line x1="82" y1="204" x2="165" y2="204" opacity="0.5" strokeDasharray="2 2" />
      </g>

      {/* Front panel — "after" with the fix */}
      <g>
        <rect x="85" y="95" width="200" height="195" rx="4" />
        {/* Title bar */}
        <line x1="85" y1="118" x2="285" y2="118" />
        <circle cx="99"  cy="106" r="2" />
        <circle cx="109" cy="106" r="2" />
        <circle cx="119" cy="106" r="2" />
        {/* Line-number gutter */}
        <line x1="118" y1="118" x2="118" y2="290" opacity="0.5" />
        {/* Code lines */}
        <line x1="132" y1="138" x2="220" y2="138" opacity="0.65" />
        <line x1="132" y1="152" x2="250" y2="152" opacity="0.65" />
        <line x1="140" y1="166" x2="225" y2="166" opacity="0.65" />
        {/* Fix row with "+" gutter mark */}
        <line x1="97"  y1="180" x2="109" y2="180" />
        <line x1="103" y1="174" x2="103" y2="186" />
        <line x1="132" y1="180" x2="265" y2="180" strokeWidth="1.4" />
        <line x1="140" y1="194" x2="205" y2="194" opacity="0.65" />
        <line x1="132" y1="208" x2="235" y2="208" opacity="0.65" />
        <line x1="132" y1="222" x2="175" y2="222" opacity="0.65" />
        <line x1="140" y1="236" x2="215" y2="236" opacity="0.65" />
        <line x1="132" y1="250" x2="195" y2="250" opacity="0.65" />
        <line x1="132" y1="264" x2="240" y2="264" opacity="0.65" />
      </g>
    </svg>
  );
}

// Fig 3 — PR card with 11 safety checks all passing
function FigGates() {
  const gateBars = [155, 180, 138, 170, 150, 190, 142, 165, 155, 175, 160];
  return (
    <svg
      viewBox="0 0 320 320"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-full h-full"
    >
      {/* PR card */}
      <rect x="35" y="30" width="250" height="260" rx="4" />

      {/* Header divider */}
      <line x1="35" y1="66" x2="285" y2="66" />

      {/* Git-branch icon on header */}
      <circle cx="55" cy="45" r="3" />
      <circle cx="55" cy="57" r="3" />
      <line x1="55" y1="48" x2="55" y2="54" />
      <circle cx="68" cy="48" r="2.5" />
      <path d="M68 50.5 Q68 54 62 54" />

      {/* PR title bars */}
      <line x1="82" y1="44" x2="190" y2="44" />
      <line x1="82" y1="53" x2="145" y2="53" opacity="0.4" />

      {/* "Ready" status badge */}
      <rect x="220" y="40" width="50" height="17" rx="8.5" />
      <circle cx="230" cy="48.5" r="2.2" fill="currentColor" opacity="0.8" />
      <line x1="237" y1="48.5" x2="262" y2="48.5" opacity="0.6" />

      {/* Section label: "11 checks — all passed" */}
      <line x1="50" y1="82" x2="82" y2="82" opacity="0.5" />
      <circle cx="90" cy="82" r="2" fill="currentColor" opacity="0.6" />
      <line x1="98" y1="82" x2="140" y2="82" opacity="0.5" />

      {/* 11 check rows */}
      {gateBars.map((w, i) => {
        const y = 100 + i * 14;
        return (
          <g key={i}>
            <circle cx="58" cy={y} r="5" />
            <path
              d={`M54.5 ${y} L57.2 ${y + 2.8} L62 ${y - 2.2}`}
              strokeWidth="1.35"
            />
            <line x1="72" y1={y} x2={72 + w} y2={y} opacity="0.55" />
          </g>
        );
      })}

      {/* Divider before merge */}
      <line x1="35" y1="258" x2="285" y2="258" opacity="0.3" />

      {/* Merge button */}
      <rect x="50" y="266" width="120" height="18" rx="4" />
      <path d="M66 275 L72 281 L84 269" strokeWidth="1.5" />
      <line x1="94" y1="275" x2="158" y2="275" opacity="0.55" />

      {/* Timestamp */}
      <line x1="200" y1="275" x2="270" y2="275" opacity="0.3" />
    </svg>
  );
}

function HowItWorks() {
  const steps = [
    {
      fig: "FIG 0.1",
      title: "Capture",
      body:
        "Ingests alerts from Sentry, Vercel, GitHub, Datadog, Expo, and your own app. Correlates signals — one alert, not three.",
      icon: <FigConvergence />,
    },
    {
      fig: "FIG 0.2",
      title: "Diagnose & fix",
      body:
        "AI reads the stack trace, your code, and past incidents. Generates a minimal fix plus a regression test that reproduces the bug.",
      icon: <FigDiff />,
    },
    {
      fig: "FIG 0.3",
      title: "Verify & ship",
      body:
        "11 safety gates — CI, self-review, security scan, staging E2E. All green, auto-merge. One red, draft PR for you.",
      icon: <FigGates />,
    },
  ];

  return (
    <section id="how" className="py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center mb-20">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-4">
            How it works
          </p>
          <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight text-fg-strong">
            From error to merged PR<br />
            in minutes — not days.
          </h2>
          <p className="mt-5 text-lg text-fg-base">
            Not a pipeline — a loop. If a stage fails, it retries with what it learned.
            If a shipped fix regresses, it auto-reverts to the last good Vercel deploy.
          </p>
        </div>

        <div className="grid md:grid-cols-3">
          {steps.map((s, i) => (
            <div
              key={s.fig}
              className={`px-8 py-10 ${
                i > 0 ? "md:border-l md:border-inari-border" : ""
              }`}
            >
              <p className="text-[10px] font-mono text-fg-base/50 tracking-[0.2em] uppercase mb-10">
                {s.fig}
              </p>
              <div className="flex items-center justify-center h-56 mb-12 text-fg-base/60">
                {s.icon}
              </div>
              <h3 className="text-base font-semibold text-fg-strong mb-3">
                {s.title}
              </h3>
              <p className="text-sm leading-relaxed text-fg-base">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Terminal preview ──────────────────────────────────────────────────────────

function TerminalPreview() {
  const gates = [
    { label: "auto_merge_enabled",  detail: "config",                     value: "on"          },
    { label: "CI passed",           detail: "3 checks",                   value: null          },
    { label: "Confidence",          detail: "≥ 90%",                      value: "94%"         },
    { label: "Diff size",           detail: "≤ 500 lines",                value: "+47 −12"     },
    { label: "Self-review",         detail: "≥ 70",                       value: "88/100"      },
    { label: "Substrate simulate",  detail: "risk ≤ 40",                  value: "risk 12"     },
    { label: "EAP chain",           detail: "Merkle · Ed25519",           value: "verified"    },
    { label: "Prediction safe",     detail: "risk ≤ 40",                  value: "risk 8"      },
    { label: "Security scan",       detail: "0 HIGH · 0 CRITICAL",        value: "clean"       },
    { label: "Substrate replay",    detail: "I/O match",                  value: "100%"        },
    { label: "Staging E2E",         detail: "12/12 tests",                value: "passed"      },
  ];

  return (
    <section className="py-24">
      <div className="mx-auto max-w-3xl px-6">
        <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0c] overflow-hidden">
          {/* Chrome */}
          <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
            <div className="flex gap-1.5">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]/70" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]/70" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]/70" />
            </div>
            <span className="font-mono text-xs text-white/25">
              03:47 — auto-merge evaluating
            </span>
            <span className="ml-auto font-mono text-[11px] text-white/20">
              trust: <span className="text-orange-400/70">Senior</span>
            </span>
          </div>

          {/* Output */}
          <div className="p-6 font-mono text-[13px] leading-none space-y-0">
            <p className="text-white/20 text-[11px] uppercase tracking-widest mb-5">
              Running 11 safety gates…
            </p>

            {gates.map((g, i) => (
              <div key={i} className="flex items-baseline gap-0 py-[5px] border-b border-white/[0.03] last:border-0">
                <span className="text-emerald-400 mr-3 shrink-0">✓</span>
                <span className="text-white/55 w-44 shrink-0">{g.label}</span>
                {g.value && (
                  <span className="text-white font-semibold mr-2">{g.value}</span>
                )}
                <span className="text-white/20 text-[11px]">{g.detail}</span>
              </div>
            ))}

            <p className="mt-6 text-inari-accent">
              → All 11 gates passed — merging PR #62…
            </p>
            <p className="mt-2.5">
              <span className="text-emerald-400">✓</span>{" "}
              <span className="text-white/60">Merged. Watching for regressions</span>{" "}
              <span className="text-white/25 text-[11px]">(10 min window)</span>
            </p>
          </div>
        </div>

        <p className="mt-4 text-center text-sm text-fg-base">
          Auto-merge is off by default. You set the threshold, diff size, and trust level per project.
        </p>
      </div>
    </section>
  );
}

// ── Platform showcase: Live remediation session ──────────────────────────────

type StageStatus = "done" | "active" | "pending";
type Stage = { label: string; status: StageStatus; time?: string };

function StageDot({ status }: { status: StageStatus }) {
  if (status === "done") {
    return (
      <div className="relative z-10 h-6 w-6 rounded-full bg-inari-card border-2 border-emerald-500/70 flex items-center justify-center">
        <svg viewBox="0 0 12 12" className="h-3 w-3 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M3 6 L5.2 8.2 L9 4.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }
  if (status === "active") {
    return (
      <div className="relative z-10 h-6 w-6 rounded-full bg-inari-card border-2 border-inari-accent flex items-center justify-center">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-inari-accent opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-inari-accent" />
        </span>
      </div>
    );
  }
  return (
    <div className="relative z-10 h-6 w-6 rounded-full bg-inari-card border-2 border-fg-base/30" />
  );
}

function DiffLine({
  n,
  kind,
  children,
}: {
  n: number | string;
  kind: "ctx" | "add" | "del";
  children: React.ReactNode;
}) {
  const bg =
    kind === "add"
      ? "bg-emerald-500/10 border-l-2 border-emerald-500/60"
      : kind === "del"
      ? "bg-red-500/10 border-l-2 border-red-500/60"
      : "border-l-2 border-transparent";
  const marker =
    kind === "add" ? <span className="text-emerald-600 dark:text-emerald-400">+</span>
    : kind === "del" ? <span className="text-red-600 dark:text-red-400">−</span>
    : <span className="text-fg-base/50"> </span>;
  const numColor =
    kind === "add" ? "text-emerald-600/80 dark:text-emerald-400/70"
    : kind === "del" ? "text-red-600/80 dark:text-red-400/70"
    : "text-fg-base/50";
  return (
    <div className={`flex items-start ${bg}`}>
      <span className={`w-7 shrink-0 pr-2 text-right text-[10px] ${numColor}`}>{n}</span>
      <span className="w-4 shrink-0 text-center">{marker}</span>
      <span className="flex-1 pr-3 text-fg-base">{children}</span>
    </div>
  );
}

function Features() {
  const stages: Stage[] = [
    { label: "Diagnose",      status: "done",    time: "1.8s" },
    { label: "Read code",     status: "done",    time: "4.2s" },
    { label: "Generate fix",  status: "done",    time: "11.3s" },
    { label: "Security scan", status: "done",    time: "2.1s" },
    { label: "CI check",      status: "active",  time: "00:47" },
    { label: "Merge",         status: "pending"               },
  ];

  return (
    <section id="features" className="py-24 sm:py-32 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-4">
            Platform
          </p>
          <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight text-fg-strong">
            Not just monitoring.<br />
            Automated fixing.
          </h2>
          <p className="mt-5 text-lg text-fg-base">
            An autonomous loop from error to merged PR. AI diagnoses, writes the
            fix, runs every safety gate, and opens the PR — while you watch live.
          </p>
        </div>
      </div>

      {/* Live remediation session card */}
      <div className="mx-auto max-w-6xl px-6 mt-16">
        <div className="relative rounded-xl border border-inari-border bg-inari-card shadow-lg dark:shadow-2xl overflow-hidden">
          {/* Top status bar */}
          <div className="flex items-center justify-between border-b border-inari-border px-5 py-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400">
                  Live
                </span>
              </div>
              <span className="text-fg-base/60">·</span>
              <span className="text-[11px] text-fg-base">Autonomous remediation in progress</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-[11px] font-mono text-fg-base/80">ALT-0142</span>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/30 uppercase tracking-wider">
                Critical
              </span>
              <span className="text-[11px] font-mono text-fg-base/80 tabular-nums">01:47</span>
            </div>
          </div>

          {/* Main — Error details + Generated fix */}
          <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x divide-inari-border">
            {/* LEFT — Error */}
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[10px] font-mono text-fg-base/70 uppercase tracking-[0.2em]">
                  Incident
                </span>
                <span className="text-fg-base/50">·</span>
                <span className="text-[10px] text-fg-base/70">via @inariwatch/capture</span>
              </div>

              <h3 className="text-sm font-semibold text-fg-strong mb-1 leading-snug">
                TypeError: Cannot read property 'id' of null
              </h3>
              <p className="text-xs text-fg-base mb-4">
                Thrown 12× in the last 2 min · 3 users affected · main @ a3f9d21
              </p>

              {/* Stack trace */}
              <div className="rounded-md border border-inari-border bg-surface-inner p-3 font-mono text-[11px] leading-6">
                <p className="text-fg-base/60">// stack trace</p>
                <p className="text-fg-base">
                  at <span className="text-inari-accent">requireUser</span>{" "}
                  <span className="text-fg-base/70">(lib/session.ts:47)</span>
                </p>
                <p className="text-fg-base">
                  at <span className="text-inari-accent">authMiddleware</span>{" "}
                  <span className="text-fg-base/70">(lib/auth.ts:12)</span>
                </p>
                <p className="text-fg-base">
                  at <span className="text-inari-accent">checkoutHandler</span>{" "}
                  <span className="text-fg-base/70">(app/api/checkout.ts:8)</span>
                </p>
                <p className="text-fg-base/60">... 2 more frames</p>
              </div>

              <div className="mt-4 flex items-center gap-3 text-[11px] text-fg-base">
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  12 events
                </span>
                <span className="text-fg-base/50">·</span>
                <span>first seen 14:02:33</span>
                <span className="text-fg-base/50">·</span>
                <span>3 users</span>
              </div>
            </div>

            {/* RIGHT — Generated fix */}
            <div className="p-6 border-t md:border-t-0 border-inari-border">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[10px] font-mono text-fg-base/70 uppercase tracking-[0.2em]">
                  Proposed fix
                </span>
              </div>

              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-mono text-fg-strong">lib/session.ts</p>
                <div className="flex items-center gap-2 text-[10px] font-mono tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+4</span>
                  <span className="text-red-600 dark:text-red-400">−1</span>
                </div>
              </div>

              {/* Diff view */}
              <div className="rounded-md border border-inari-border bg-surface-inner overflow-hidden font-mono text-[11px] leading-5 py-1.5">
                <DiffLine n={45} kind="ctx">
                  export function <span className="text-inari-accent">requireUser</span>(req) {"{"}
                </DiffLine>
                <DiffLine n={46} kind="del">
                  {"  "}return req.session.user;
                </DiffLine>
                <DiffLine n={46} kind="add">
                  {"  "}if (!req.session?.user) {"{"}
                </DiffLine>
                <DiffLine n={47} kind="add">
                  {"    "}throw new <span className="text-inari-accent">Unauthorized</span>();
                </DiffLine>
                <DiffLine n={48} kind="add">
                  {"  "}{"}"}
                </DiffLine>
                <DiffLine n={49} kind="add">
                  {"  "}return req.session.user;
                </DiffLine>
                <DiffLine n={50} kind="ctx">
                  {"}"}
                </DiffLine>
              </div>

              <div className="mt-4 flex items-center gap-3 text-[11px] text-fg-base flex-wrap">
                <span>confidence</span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold tabular-nums">94%</span>
                <span className="text-fg-base/50">·</span>
                <span>regression test generated</span>
                <span className="text-fg-base/50">·</span>
                <span>branch <span className="font-mono text-fg-strong">inari/fix-ALT-0142</span></span>
              </div>
            </div>
          </div>

          {/* Bottom — pipeline progress */}
          <div className="border-t border-inari-border px-8 py-6">
            <div className="flex items-center gap-2 mb-5">
              <span className="text-[10px] font-mono text-fg-base/70 uppercase tracking-[0.2em]">
                Pipeline
              </span>
              <span className="text-fg-base/50">·</span>
              <span className="text-[10px] text-fg-base/70">
                4 of 6 stages complete · 2 remaining
              </span>
            </div>

            <div className="relative">
              {/* Connector line behind dots */}
              <div className="absolute left-3 right-3 top-3 h-px bg-inari-border" />

              <div
                className="relative grid"
                style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
              >
                {stages.map((s) => (
                  <div key={s.label} className="flex flex-col items-center gap-2">
                    <StageDot status={s.status} />
                    <span
                      className={`text-[10px] font-medium text-center ${
                        s.status === "pending"
                          ? "text-fg-base/60"
                          : s.status === "active"
                          ? "text-inari-accent"
                          : "text-fg-strong"
                      }`}
                    >
                      {s.label}
                    </span>
                    <span className="text-[9px] font-mono text-fg-base/60 tabular-nums">
                      {s.time ?? "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-xs font-mono uppercase tracking-widest text-fg-base/60">
          One session — from alert to merged PR
        </p>
      </div>
    </section>
  );
}

// ── Community Fix Network ─────────────────────────────────────────────────────

type NetworkHeadlineStats = {
  patterns:     number;
  applications: number;
  successRate:  number;
  ratings:      number;
};

async function getNetworkHeadlineStats(): Promise<NetworkHeadlineStats | null> {
  try {
    const [patRes, fxRes, rtRes] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(errorPatterns),
      db.select({
        applications: sql<number>`coalesce(sum(${communityFixes.totalApplications}), 0)::int`,
        success:      sql<number>`coalesce(sum(${communityFixes.successCount}), 0)::int`,
      }).from(communityFixes),
      db.select({ count: sql<number>`count(*)::int` }).from(fixRatings),
    ]);
    const applications = fxRes[0]?.applications ?? 0;
    const success      = fxRes[0]?.success      ?? 0;
    const successRate  = applications > 0 ? Math.round((success / applications) * 100) : 0;
    return {
      patterns:     patRes[0]?.count ?? 0,
      applications,
      successRate,
      ratings:      rtRes[0]?.count ?? 0,
    };
  } catch {
    return null;
  }
}

// ── Replay teaser section ─────────────────────────────────────────────────────

function ReplaySection() {
  return (
    <section className="py-24 sm:py-32 border-t border-inari-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid md:grid-cols-[1fr_1.05fr] gap-12 lg:gap-16 items-center">
          {/* Left — copy */}
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-3 py-1 mb-5">
              <span className="h-1.5 w-1.5 rounded-full bg-inari-accent animate-pulse" />
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-inari-accent">New · Session Replay</span>
            </div>
            <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight text-fg-strong leading-[1.05]">
              See the bug.<br />
              <span className="text-gradient-accent">Ship the fix.</span>
            </h2>
            <p className="mt-5 text-lg text-fg-base leading-relaxed max-w-md">
              Watch any user session — DOM, console, network, Web Vitals, frustration —
              then click <span className="font-semibold text-fg-strong">Generate Fix</span>{" "}
              and InariWatch opens the PR.
            </p>
            <ul className="mt-6 space-y-2.5">
              {[
                "AI-narrated chapters explain what the user did",
                "Rage + dead-click detection ranks frustration",
                "Web Vitals on the same timeline as your code",
                "One-click PR — every safety gate already checked",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2 text-sm text-fg-base">
                  <CheckCircle2 className="h-4 w-4 text-inari-accent shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <Link href="/replay">
                <Button variant="primary" size="lg" className="min-w-[160px]">
                  Try the demo <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/register">
                <Button variant="ghost" size="lg" className="min-w-[160px]">
                  Start free
                </Button>
              </Link>
            </div>
          </div>

          {/* Right — "from frustration to PR" flow */}
          <div className="relative">
            {/* Soft accent glow behind */}
            <div
              className="absolute -inset-8 pointer-events-none"
              style={{ background: "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(249,115,22,0.10) 0%, transparent 70%)" }}
              aria-hidden
            />

            <div className="relative space-y-3">
              {/* Frustrated session card — highlighted */}
              <Link
                href="/replay"
                className="group block rounded-xl border border-inari-accent/30 bg-inari-card hover:border-inari-accent/60 transition-all px-4 py-3.5 relative overflow-hidden"
                style={{ boxShadow: "0 8px 32px rgba(249,115,22,0.08)" }}
              >
                {/* Accent edge */}
                <span className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r-full bg-inari-accent/80" aria-hidden />
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="font-mono text-[11px] text-fg-base/50">sess_a3f2…</span>
                    <span className="inline-flex items-center gap-1 rounded-md bg-inari-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-inari-accent truncate max-w-[160px]">
                      alex@acme.dev
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-fg-base/50 shrink-0">2m ago</span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mb-2.5">
                  <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> 1 error
                  </span>
                  <span className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    LCP poor
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    3 rage · 1 dead
                  </span>
                </div>
                <p className="text-sm text-fg-base leading-snug mb-3">
                  User reached checkout, hit a slow LCP, then rage-clicked Pay Now after a TypeError fired in the order total handler.
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-[11px] text-fg-base/60">
                    <span className="font-mono">2:14</span>
                    <span>·</span>
                    <span>Chrome · macOS</span>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-inari-accent/15 group-hover:bg-inari-accent/25 px-2.5 py-1 text-[11px] font-medium text-inari-accent transition-colors">
                    <GitPullRequest className="h-3 w-3" />
                    Generate Fix
                  </span>
                </div>
              </Link>

              {/* Quieter cards behind, faded */}
              <div className="rounded-xl border border-inari-border bg-inari-card/60 px-4 py-3 opacity-70">
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-fg-base/50">sess_91bd…</span>
                    <span className="inline-flex items-center rounded-md bg-fg-base/10 px-1.5 py-0.5 text-[10px] font-medium text-fg-base/60 truncate max-w-[140px]">
                      maria@stripe.io
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-fg-base/50">11m</span>
                </div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="inline-flex items-center rounded-md bg-fg-base/10 px-1.5 py-0.5 text-[10px] font-mono text-fg-base/55">
                    LCP good
                  </span>
                  <span className="text-[10px] text-fg-base/50">no errors · 1m 47s</span>
                </div>
              </div>

              <div className="rounded-xl border border-inari-border bg-inari-card/40 px-4 py-3 opacity-50">
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-fg-base/50">sess_77a4…</span>
                    <span className="inline-flex items-center rounded-md bg-fg-base/10 px-1.5 py-0.5 text-[10px] font-medium text-fg-base/60 truncate max-w-[140px]">
                      david@acme.dev
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-fg-base/50">38m</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-fg-base/50">no errors · 4m 12s</span>
                </div>
              </div>

              {/* Arrow connector */}
              <div className="flex flex-col items-center pt-1 pb-1" aria-hidden>
                <ArrowRight className="h-4 w-4 text-inari-accent rotate-90" />
              </div>

              {/* PR card — the result */}
              <div className="rounded-xl border border-emerald-500/30 bg-inari-card px-4 py-3 relative overflow-hidden"
                   style={{ boxShadow: "0 8px 32px rgba(16,185,129,0.06)" }}
              >
                <span className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r-full bg-emerald-500/80" aria-hidden />
                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 rounded-md bg-emerald-500/10 flex items-center justify-center shrink-0 mt-px">
                    <GitPullRequest className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[10px] text-fg-base/50">PR #4821</span>
                      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" /> 11/11 gates
                      </span>
                      <span className="inline-flex items-center rounded-md bg-fg-base/5 px-1.5 py-0.5 text-[10px] font-mono text-fg-base/60">
                        +12 −1
                      </span>
                    </div>
                    <p className="text-sm font-semibold text-fg-strong mt-1.5 leading-snug">
                      Guard <span className="font-mono text-inari-accent">order.total</span> before render
                    </p>
                    <p className="text-[11px] text-fg-base/60 mt-0.5">
                      <span className="font-mono">checkout/page.tsx</span> · auto-merged 14s ago
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function NetworkSection({ stats }: { stats: NetworkHeadlineStats | null }) {
  return (
    <section className="py-24 sm:py-32 border-t border-inari-border">
      <div className="mx-auto max-w-5xl px-6">

        {/* Header */}
        <div className="text-center mx-auto max-w-2xl">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-4">
            Community Fix Network
          </p>
          <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight text-fg-strong leading-[1.05]">
            One team fixes it.<br />
            <span className="text-gradient-accent">Everyone benefits.</span>
          </h2>
          <p className="mt-5 text-lg text-fg-base">
            When InariWatch fixes an error on your project, the pattern is anonymized and shared.
            The next team with the same error sees an instant match — because someone already solved it.
          </p>
        </div>

        {/* Live stats — hidden if DB query fails */}
        {stats && (
          <dl className="mt-12 rounded-xl border border-inari-border bg-inari-card grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-inari-border">
            {[
              { value: stats.patterns.toLocaleString(),     label: "error patterns"    },
              { value: stats.applications.toLocaleString(), label: "fixes applied"     },
              { value: `${stats.successRate}%`,             label: "success rate"      },
              { value: stats.ratings.toLocaleString(),      label: "community ratings" },
            ].map((s) => (
              <div key={s.label} className="px-6 py-5 text-center">
                <dd className="text-3xl font-semibold text-fg-strong font-mono tabular-nums">{s.value}</dd>
                <dt className="mt-1 text-[10px] font-mono uppercase tracking-widest text-fg-base/70">{s.label}</dt>
              </div>
            ))}
          </dl>
        )}

        {/* "Match found" visual — shows the moment when a community fix is suggested */}
        <div className="mt-8 mx-auto max-w-2xl rounded-xl border border-inari-border bg-inari-card overflow-hidden shadow-lg dark:shadow-2xl">
          {/* Alert header */}
          <div className="px-5 py-4 border-b border-inari-border">
            <div className="flex items-center gap-2 mb-2">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
              <span className="text-[10px] font-mono uppercase tracking-widest text-red-600 dark:text-red-400">
                Critical
              </span>
              <span className="text-[10px] text-fg-base/60">· 2m ago</span>
              <span className="ml-auto text-[10px] font-mono text-fg-base/50">via @inariwatch/capture</span>
            </div>
            <p className="text-sm font-semibold text-fg-strong">
              TypeError: Cannot read properties of undefined
            </p>
            <p className="mt-1 font-mono text-[11px] text-fg-base/70">
              at getUserSession (lib/auth.ts:12)
            </p>
          </div>

          {/* Match found banner */}
          <div className="px-5 py-4 bg-inari-accent/[0.06] flex items-center gap-3">
            <div className="h-7 w-7 rounded-full bg-inari-accent/15 border border-inari-accent/30 flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-3.5 w-3.5 text-inari-accent" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-mono uppercase tracking-widest text-inari-accent">
                Match found in community network
              </p>
              <p className="mt-0.5 text-[11px] text-fg-base leading-snug">
                <span className="font-semibold text-fg-strong">47 teams</span> fixed this ·
                <span className="font-semibold text-fg-strong"> 96%</span> success ·
                <span className="font-mono text-fg-base/80"> ~2.1s</span> avg fix
              </p>
            </div>
            <span className="shrink-0 hidden sm:inline-flex items-center gap-1.5 rounded-md bg-inari-accent px-3 py-1.5 text-[11px] font-medium text-white">
              Apply fix
              <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </span>
          </div>
        </div>

        {/* CTA */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/network"
            className="group inline-flex items-center gap-1.5 text-sm text-inari-accent hover:text-inari-accent/80 transition-colors"
          >
            Explore the full network
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
          <span className="hidden sm:inline text-fg-base/30" aria-hidden="true">·</span>
          <span className="text-xs font-mono text-fg-base/70">
            Auto-contributed · anonymized · 60% success threshold
          </span>
        </div>

      </div>
    </section>
  );
}

// ── MCP section ───────────────────────────────────────────────────────────────

function McpSection() {
  const editors = [
    { name: "Claude Code",    icon: <ClaudeIcon className="h-4 w-4" /> },
    { name: "Cursor",         icon: <CursorIcon className="h-4 w-4" /> },
    { name: "Windsurf",       icon: <WindsurfIcon className="h-4 w-4" /> },
    { name: "VS Code Copilot", icon: <VSCodeIcon className="h-4 w-4" /> },
    { name: "Codex CLI",      icon: <CodexIcon className="h-4 w-4" /> },
    { name: "Gemini CLI",     icon: <GeminiIcon className="h-4 w-4" /> },
    { name: "OpenClaw",       icon: <OpenClawIcon className="h-4 w-4" /> },
  ];

  return (
    <section className="py-24 sm:py-32 border-t border-inari-border">
      <div className="mx-auto max-w-5xl px-6 text-center">
        <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-4">
          MCP Server
        </p>
        <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight text-fg-strong">
          Your AI editor<br />
          already knows what broke.
        </h2>
        <p className="mt-5 text-lg text-fg-base max-w-2xl mx-auto">
          One command connects InariWatch to any AI coding tool. 25 tools, 4 live
          resources, 7 prompt workflows — your AI gets full production context
          before you even ask.
        </p>

        <div className="mt-10 max-w-xl mx-auto">
          <div className="rounded-xl border border-inari-border bg-inari-card overflow-hidden text-left">
            <div className="flex items-center gap-2 border-b border-inari-border px-4 py-3">
              <div className="flex gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
              </div>
              <span className="ml-2 text-xs text-fg-base font-mono">terminal</span>
            </div>
            <div className="p-5 font-mono text-sm">
              <p className="text-fg-base/70 text-xs mb-2"># One command. Everything configured.</p>
              <p>
                <span className="text-inari-accent select-none">$ </span>
                <span className="text-fg-strong">npx @inariwatch/mcp init</span>
              </p>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
          {editors.map((e) => (
            <div
              key={e.name}
              className="flex items-center gap-2 rounded-full border border-inari-border bg-inari-card px-3 py-1.5 text-xs text-fg-base"
            >
              <span className="shrink-0">{e.icon}</span>
              {e.name}
            </div>
          ))}
        </div>

        <div className="mt-8">
          <Link
            href="/docs#mcp-overview"
            className="inline-flex items-center gap-1.5 text-sm text-inari-accent hover:text-[#f97316] transition-colors"
          >
            MCP docs — all 25 tools
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

// ── Final CTA ─────────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="py-24 sm:py-32 border-t border-inari-border">
      <div className="relative mx-auto max-w-3xl px-6 text-center">
        <div className="absolute inset-0 bg-radial-fade pointer-events-none" aria-hidden />
        <div className="relative">
          <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight text-fg-strong">
            Sleep through incidents.
          </h2>
          <p className="mt-5 text-lg text-fg-base max-w-xl mx-auto">
            Free in beta. No credit card. Set up in under a minute — InariWatch
            starts watching your stack the moment you connect GitHub.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/register">
              <Button variant="primary" size="lg" className="min-w-[180px]">
                Start free
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link href="/docs">
              <Button variant="outline" size="lg" className="min-w-[180px]">
                Read the docs
              </Button>
            </Link>
          </div>
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
            <Image
              src="/logo-inari/favicon-96x96.png"
              alt="InariWatch"
              width={24}
              height={24}
            />
            <span className="font-mono text-sm text-fg-base">
              inariwatch · built in MX
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fg-base">
            <Link href="/docs" className="hover:text-fg-strong transition-colors">Docs</Link>
            <Link href="/pricing" className="hover:text-fg-strong transition-colors">Pricing</Link>
            <Link href="/download" className="hover:text-fg-strong transition-colors">Mobile</Link>
            <Link href="/trust" className="hover:text-fg-strong transition-colors">Trust</Link>
            <Link href="/status" className="hover:text-fg-strong transition-colors">Status</Link>
            <Link href="/blog" className="hover:text-fg-strong transition-colors">Blog</Link>
            <a
              href="https://github.com/orbita-pos/inariwatch"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg-strong transition-colors"
            >
              GitHub
            </a>
            <Link href="/privacy" className="hover:text-fg-strong transition-colors">Privacy</Link>
            <Link href="/terms" className="hover:text-fg-strong transition-colors">Terms</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

async function getLatestPost(): Promise<LatestPost> {
  try {
    const rows = await db
      .select({ slug: blogPosts.slug, title: blogPosts.title })
      .from(blogPosts)
      .where(eq(blogPosts.isPublished, true))
      .orderBy(desc(blogPosts.publishedAt))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export default async function LandingPage() {
  const [latestPost, networkStats] = await Promise.all([
    getLatestPost(),
    getNetworkHeadlineStats(),
  ]);

  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav />
      <main>
        <Hero latestPost={latestPost} />
        <RuntimeStrip />
        <QuickInstall />
        <DemoVideo />
        <TrustedBy />
        <HowItWorks />
        <TerminalPreview />
        <Features />
        <ReplaySection />
        <NetworkSection stats={networkStats} />
        <McpSection />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
