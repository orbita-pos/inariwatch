import Link from "next/link";
import { ArrowRight, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "../marketing-nav";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trust Architecture — InariWatch",
  description:
    "6 layers of safety between an AI diagnosis and your production code. Zero autonomy by default — earned through a proven track record.",
};

// ── Layer data ──────────────────────────────────────────────────────────────

const LAYERS = [
  {
    n: "01",
    gate: "CONFIDENCE GATE",
    headline: "If the AI isn't sure, it stops.",
    metric: "< 30%",
    metricLabel: "confidence = abort",
    detail:
      "Every diagnosis comes with a confidence score derived from the actual logs, stack traces, and build output. Below 30%, the pipeline halts and escalates to a human. No guessing. No 'maybe this will work' deployments.",
    visual: "abort",
  },
  {
    n: "02",
    gate: "SELF-REVIEW",
    headline: "The AI reviews its own fix — and can reject it.",
    metric: "< 60",
    metricLabel: "review score = reject",
    detail:
      "A second AI pass acts as a code reviewer. It checks for regressions, type errors, missing imports, and unnecessary changes. Score below 60? The fix is rejected before it ever touches a branch.",
    visual: "review",
  },
  {
    n: "03",
    gate: "FILE BLOCKLIST",
    headline: "Some files are untouchable. Period.",
    metric: "0",
    metricLabel: "exceptions",
    detail:
      ".env, .lock files, CI configs, migration files, credentials — hardcoded blocklist. No override, no flag to bypass. The AI physically cannot generate changes to these paths.",
    visual: "block",
  },
  {
    n: "04",
    gate: "CI MUST PASS",
    headline: "Your existing tests are the final judge.",
    metric: "3×",
    metricLabel: "retry with different approach",
    detail:
      "The fix runs through your full CI pipeline. If it fails, the AI analyzes the CI error and tries a completely different approach — up to 3 times. Three failures? Escalates to your on-call. No PR is created.",
    visual: "ci",
  },
  {
    n: "05",
    gate: "TRUST LEVELS",
    headline: "Zero autonomy by default. Earned, not given.",
    metric: "4",
    metricLabel: "clearance levels",
    detail:
      "Every project starts at Rookie — draft PRs only, human must approve every merge. The system earns trust through successful fixes with passing CI and no regressions. Each level unlocks tighter auto-merge gates.",
    visual: "trust",
  },
  {
    n: "06",
    gate: "POST-MERGE MONITOR",
    headline: "Merged doesn't mean done.",
    metric: "10 min",
    metricLabel: "active monitoring",
    detail:
      "After merge, InariWatch monitors for 10 minutes. New errors detected? Automatic revert. The branch is rolled back, the incident is re-opened, and your on-call is notified. No human intervention needed.",
    visual: "monitor",
  },
] as const;

const TRUST_LEVELS = [
  {
    level: 0,
    name: "ROOKIE",
    color: "text-zinc-500",
    border: "border-zinc-700",
    bg: "bg-zinc-900/50",
    auto: "Draft PR only",
    gates: "Human approves every merge",
  },
  {
    level: 1,
    name: "APPRENTICE",
    color: "text-amber-400",
    border: "border-amber-900/50",
    bg: "bg-amber-950/20",
    auto: "Auto-merge enabled",
    gates: "Confidence \u2265 90% \u00b7 Review \u2265 80 \u00b7 \u2264 30 lines",
  },
  {
    level: 2,
    name: "TRUSTED",
    color: "text-cyan-400",
    border: "border-cyan-900/50",
    bg: "bg-cyan-950/20",
    auto: "Expanded autonomy",
    gates: "Confidence \u2265 80% \u00b7 Review \u2265 70 \u00b7 \u2264 40 lines",
  },
  {
    level: 3,
    name: "EXPERT",
    color: "text-green-400",
    border: "border-green-900/50",
    bg: "bg-green-950/20",
    auto: "Full auto-merge",
    gates: "Confidence \u2265 70% \u00b7 Review \u2265 60 \u00b7 \u2264 50 lines",
  },
];

// ── Page ────────────────────────────────────────────────────────────────────

export default function TrustPage() {
  return (
    <div className="min-h-screen bg-[#06060a] text-white">
      <MarketingNav />

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden pt-32 pb-24 sm:pt-40 sm:pb-32">
        {/* Grid background */}
        <div className="absolute inset-0 bg-grid opacity-30" />
        <div className="absolute inset-0 bg-radial-fade" />

        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-4 py-1.5">
            <Shield className="h-3.5 w-3.5 text-inari-accent" />
            <span className="text-xs font-mono text-inari-accent tracking-wide">
              TRUST ARCHITECTURE
            </span>
          </div>

          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl lg:text-7xl leading-[1.05]">
            6 layers between
            <br />
            <span className="text-gradient-accent glow-accent-text">
              AI and your production.
            </span>
          </h1>

          <p className="mt-6 text-lg text-zinc-400 max-w-2xl mx-auto leading-relaxed">
            Auto-generated fixes on a misdiagnosed alert? That&apos;s what these
            gates prevent. Every fix must survive all six — or a human
            decides.
          </p>

          {/* Pipeline visualization */}
          <div className="mt-16 flex items-center justify-center gap-0">
            {LAYERS.map((l, i) => (
              <div key={l.n} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5">
                  <div className="h-10 w-10 sm:h-12 sm:w-12 rounded-full border border-inari-accent/40 bg-inari-accent/5 flex items-center justify-center">
                    <span className="font-mono text-xs sm:text-sm text-inari-accent font-bold">
                      {l.n}
                    </span>
                  </div>
                  <span className="text-[9px] sm:text-[10px] text-zinc-600 font-mono uppercase tracking-wider max-w-[70px] text-center leading-tight hidden sm:block">
                    {l.gate}
                  </span>
                </div>
                {i < LAYERS.length - 1 && (
                  <div className="w-6 sm:w-10 h-px bg-gradient-to-r from-inari-accent/40 to-inari-accent/10 mx-1" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Layers ────────────────────────────────────────────────── */}
      {LAYERS.map((layer, i) => (
        <section
          key={layer.n}
          className={`relative border-t border-white/[0.04] ${
            i % 2 === 0 ? "bg-[#06060a]" : "bg-[#08080e]"
          }`}
        >
          <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32">
            <div className="grid gap-12 lg:grid-cols-2 lg:gap-20 items-center">
              {/* Text side */}
              <div className={i % 2 === 1 ? "lg:order-2" : ""}>
                <div className="flex items-center gap-3 mb-6">
                  <span className="font-mono text-5xl sm:text-6xl font-bold text-white/[0.06] leading-none select-none">
                    {layer.n}
                  </span>
                  <div>
                    <p className="font-mono text-[10px] text-inari-accent tracking-[0.2em] uppercase">
                      Layer {layer.n}
                    </p>
                    <p className="font-mono text-xs text-zinc-500 uppercase tracking-wider">
                      {layer.gate}
                    </p>
                  </div>
                </div>

                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white leading-tight">
                  {layer.headline}
                </h2>

                <p className="mt-4 text-sm text-zinc-400 leading-relaxed max-w-md">
                  {layer.detail}
                </p>
              </div>

              {/* Metric / Visual side */}
              <div className={`flex justify-center ${i % 2 === 1 ? "lg:order-1" : ""}`}>
                {layer.visual === "trust" ? (
                  <TrustLevelVisual />
                ) : (
                  <MetricCard metric={layer.metric} label={layer.metricLabel} gate={layer.gate} />
                )}
              </div>
            </div>
          </div>
        </section>
      ))}

      {/* ── The answer ────────────────────────────────────────────── */}
      <section className="relative border-t border-white/[0.04] bg-[#06060a]">
        <div className="absolute inset-0 bg-radial-fade opacity-50" />
        <div className="relative mx-auto max-w-4xl px-6 py-24 sm:py-32">
          <div className="text-center">
            <p className="font-mono text-[10px] text-inari-accent tracking-[0.3em] uppercase mb-6">
              THE ANSWER
            </p>
            <h2 className="text-3xl sm:text-5xl font-bold tracking-tight text-white leading-tight">
              &ldquo;How much human review
              <br />
              is expected?&rdquo;
            </h2>
            <div className="mt-10 mx-auto max-w-2xl text-left space-y-6">
              <AnswerBlock
                title="By default: 100%."
                body="Every project starts at Trust Level 0 (Rookie). The AI creates draft PRs only. A human reviews and merges every single fix."
              />
              <AnswerBlock
                title="Autonomy is earned, not configured."
                body="The system builds a track record. Fixes that pass CI, survive post-merge monitoring, and cause zero regressions count toward the next trust level. Bad fixes reset progress."
              />
              <AnswerBlock
                title="Even at maximum trust, 5 gates must pass."
                body="If a single gate fails — low confidence, failed self-review, CI error, or too many lines changed — it falls back to a draft PR. Human decides."
              />
              <AnswerBlock
                title="Worst case: auto-revert in 10 minutes."
                body="If a fix somehow passes all gates and causes a new error in production, the post-merge monitor auto-reverts the change. No human intervention needed."
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Comparison ────────────────────────────────────────────── */}
      <section className="border-t border-white/[0.04] bg-[#08080e]">
        <div className="mx-auto max-w-4xl px-6 py-24 sm:py-32">
          <p className="font-mono text-[10px] text-zinc-600 tracking-[0.3em] uppercase mb-8 text-center">
            PERSPECTIVE
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="rounded-xl border border-red-900/30 bg-red-950/10 p-6">
              <p className="font-mono text-xs text-red-400/70 uppercase tracking-wider mb-3">
                Dev hotfix at 3 AM
              </p>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li className="flex items-start gap-2">
                  <span className="text-red-500 mt-0.5">-</span>
                  No second reviewer
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-500 mt-0.5">-</span>
                  &ldquo;Skip CI, it&apos;s urgent&rdquo;
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-500 mt-0.5">-</span>
                  No post-merge monitoring
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-500 mt-0.5">-</span>
                  Revert is manual if it breaks
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-500 mt-0.5">-</span>
                  Cognitive load at lowest point
                </li>
              </ul>
            </div>
            <div className="rounded-xl border border-inari-accent/30 bg-inari-accent/5 p-6">
              <p className="font-mono text-xs text-inari-accent/70 uppercase tracking-wider mb-3">
                InariWatch auto-fix
              </p>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  AI self-review on every fix
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  Full CI must pass (3 retries)
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  10-min post-merge monitor
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  Auto-revert if new errors
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  Consistent process, always
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────── */}
      <section className="border-t border-white/[0.04] bg-[#06060a]">
        <div className="relative mx-auto max-w-4xl px-6 py-24 sm:py-32 text-center">
          <div className="absolute inset-0 bg-radial-fade opacity-30" />
          <div className="relative">
            <h2 className="text-2xl sm:text-4xl font-bold tracking-tight text-white">
              Safer than your 3 AM hotfix.
            </h2>
            <p className="mt-4 text-zinc-500 max-w-lg mx-auto">
              Start at zero trust. Watch it earn your confidence — one
              successful fix at a time.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/register">
                <Button variant="primary" className="px-8 py-3">
                  Start free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/docs">
                <Button
                  variant="outline"
                  className="px-8 py-3 border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600"
                >
                  Read the docs
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({
  metric,
  label,
  gate,
}: {
  metric: string;
  label: string;
  gate: string;
}) {
  return (
    <div className="relative w-full max-w-[280px]">
      {/* Outer ring */}
      <div className="aspect-square rounded-2xl border border-white/[0.04] bg-white/[0.01] p-6 flex flex-col items-center justify-center text-center">
        <p className="font-mono text-5xl sm:text-6xl font-bold text-white tracking-tight">
          {metric}
        </p>
        <p className="mt-2 font-mono text-xs text-zinc-500 uppercase tracking-wider">
          {label}
        </p>
        <div className="mt-4 h-px w-12 bg-inari-accent/30" />
        <p className="mt-3 font-mono text-[10px] text-inari-accent/50 uppercase tracking-[0.15em]">
          {gate}
        </p>
      </div>
    </div>
  );
}

function TrustLevelVisual() {
  return (
    <div className="w-full max-w-sm space-y-3">
      {TRUST_LEVELS.map((t) => (
        <div
          key={t.level}
          className={`rounded-lg border ${t.border} ${t.bg} px-4 py-3 flex items-center gap-4`}
        >
          <div className="flex flex-col items-center w-12 shrink-0">
            <span className={`font-mono text-2xl font-bold ${t.color}`}>
              {t.level}
            </span>
          </div>
          <div className="min-w-0">
            <p className={`font-mono text-xs font-bold tracking-wider ${t.color}`}>
              {t.name}
            </p>
            <p className="text-[11px] text-zinc-500 mt-0.5">{t.auto}</p>
            <p className="text-[10px] text-zinc-600 font-mono mt-0.5">
              {t.gates}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function AnswerBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="border-l-2 border-inari-accent/30 pl-5">
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="mt-1 text-sm text-zinc-400 leading-relaxed">{body}</p>
    </div>
  );
}
