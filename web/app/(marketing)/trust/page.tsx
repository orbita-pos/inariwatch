import Link from "next/link";
import { ArrowRight, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "../marketing-nav";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trust Architecture — InariWatch",
  description:
    "11 safety gates, 4 trust levels, and 36 security checks between an AI diagnosis and your production code. Zero autonomy by default — earned through a proven track record.",
};

// ── Layer data ──────────────────────────────────────────────────────────────

type Layer = {
  n: string;
  gate: string;
  headline: string;
  metric: string;
  metricLabel: string;
  detail: string;
  /** Gate runs on every remediation — no extra setup. */
  alwaysOn: boolean;
};

const LAYERS: readonly Layer[] = [
  {
    n: "01",
    gate: "CONFIDENCE GATE",
    headline: "If the AI isn't sure, it stops.",
    metric: "70\u201390%",
    metricLabel: "threshold by trust level",
    detail:
      "Every diagnosis comes with a confidence score derived from the actual logs, stack traces, and build output. The threshold adapts to trust level: Apprentice requires 90%, Trusted 80%, Expert 70%. Below threshold, the fix becomes a draft PR for human review. Rookies never auto-merge.",
    alwaysOn: true,
  },
  {
    n: "02",
    gate: "SECURITY SCAN",
    headline: "36 checks before the fix leaves your server.",
    metric: "36",
    metricLabel: "security checks",
    detail:
      "Every AI-generated fix is scanned by 3 layers: 17 ESLint rules (3 built-in + 14 from eslint-plugin-security), 19 Semgrep-inspired pattern detectors (SSRF, SQL injection, XSS, prototype pollution, hardcoded secrets, open redirect), and an AI security review. Any HIGH finding blocks auto-merge.",
    alwaysOn: true,
  },
  {
    n: "03",
    gate: "SELF-REVIEW",
    headline: "The AI reviews its own fix — and can reject it.",
    metric: "< 70",
    metricLabel: "score or 'reject' = blocked",
    detail:
      "A second AI pass acts as a code reviewer. It checks for regressions, type errors, missing imports, and unnecessary changes. Score below 70 or explicit 'reject' recommendation? The fix is blocked before it ever touches a branch.",
    alwaysOn: true,
  },
  {
    n: "04",
    gate: "FILE BLOCKLIST",
    headline: "Some files are untouchable. Period.",
    metric: "14",
    metricLabel: "blocked patterns",
    detail:
      ".env, lock files, CI configs, migrations, Dockerfiles, Terraform, secrets, certificates — 14 hardcoded patterns. No override, no flag to bypass. The AI physically cannot generate changes to these paths.",
    alwaysOn: true,
  },
  {
    n: "05",
    gate: "CI MUST PASS",
    headline: "Your existing tests are the final judge.",
    metric: "3\u00d7",
    metricLabel: "retry with different approach",
    detail:
      "The fix runs through your full CI pipeline. If it fails, the AI analyzes the CI error and tries a completely different approach — up to 3 times. Three failures? Escalates to your on-call. No PR is created.",
    alwaysOn: true,
  },
  {
    n: "06",
    gate: "PREDICTION ENGINE",
    headline: "Pre-deployment error detection.",
    metric: "3",
    metricLabel: "prediction layers",
    detail:
      "Before merge, the prediction engine runs 3 layers: pattern matching against historical alerts, AI prediction on the diff, and shadow replay of production I/O recordings against the fix code. Risk score above 40? Blocked.",
    alwaysOn: true,
  },
  {
    n: "07",
    gate: "SUBSTRATE REPLAY",
    headline: "Replay production I/O against the fix.",
    metric: "\u2264 40",
    metricLabel: "risk score to pass",
    detail:
      "If Substrate recordings exist, InariWatch replays real HTTP calls, DB queries, and file operations from before the crash against the fixed code. Two modes: fast AI analysis or real GitHub Action replay. Activates automatically when Substrate recordings are available for the project.",
    alwaysOn: false,
  },
  {
    n: "08",
    gate: "EAP VERIFICATION",
    headline: "Cryptographic proof the fix was verified.",
    metric: "\u2713",
    metricLabel: "chain verified",
    detail:
      "The Execution Attestation Protocol creates a Merkle tree of every step in the remediation pipeline, signed with Ed25519. Each fix gets a cryptographic receipt chain proving it passed every gate. Activates when a Cortex server is connected — the infrastructure is built and ready, deployed on demand.",
    alwaysOn: false,
  },
  {
    n: "09",
    gate: "TRUST LEVELS",
    headline: "Zero autonomy by default. Earned, not given.",
    metric: "4",
    metricLabel: "clearance levels",
    detail:
      "Every project starts at Rookie — draft PRs only, human must approve every merge. The system earns trust through successful fixes with passing CI and no regressions. Computed from actual remediation history, not configured.",
    alwaysOn: true,
  },
  {
    n: "10",
    gate: "POST-MERGE MONITOR",
    headline: "Merged doesn't mean done.",
    metric: "10 min",
    metricLabel: "active monitoring",
    detail:
      "After merge, InariWatch monitors for 10 minutes. New errors detected? Automatic revert. The branch is rolled back, the incident is re-opened, and your on-call is notified. No human intervention needed.",
    alwaysOn: true,
  },
  {
    n: "11",
    gate: "ESCALATION ENGINE",
    headline: "When AI can't fix it, humans are notified instantly.",
    metric: "5",
    metricLabel: "escalation triggers",
    detail:
      "Low confidence, fix failed, max retries exhausted, self-review rejected, or regression detected — any of these triggers smart escalation to your on-call team via Slack, Telegram, email, or push notification.",
    alwaysOn: true,
  },
];

const TRUST_LEVELS = [
  {
    level: 0,
    name: "ROOKIE",
    color: "text-zinc-500",
    border: "border-zinc-700",
    bg: "bg-zinc-900/50",
    auto: "Draft PR only",
    gates: "Human approves every merge",
    requirement: "Starting state",
  },
  {
    level: 1,
    name: "APPRENTICE",
    color: "text-amber-400",
    border: "border-amber-900/50",
    bg: "bg-amber-950/20",
    auto: "Auto-merge enabled",
    gates: "Confidence \u2265 90% \u00b7 Review \u2265 70 \u00b7 \u2264 50 lines",
    requirement: "\u2265 3 fixes, \u2265 50% success rate",
  },
  {
    level: 2,
    name: "TRUSTED",
    color: "text-cyan-400",
    border: "border-cyan-900/50",
    bg: "bg-cyan-950/20",
    auto: "Expanded autonomy",
    gates: "Confidence \u2265 80% \u00b7 Review \u2265 70 \u00b7 \u2264 100 lines",
    requirement: "\u2265 5 fixes, \u2265 70% success rate",
  },
  {
    level: 3,
    name: "EXPERT",
    color: "text-green-400",
    border: "border-green-900/50",
    bg: "bg-green-950/20",
    auto: "Full auto-merge",
    gates: "Confidence \u2265 70% \u00b7 Review \u2265 70 \u00b7 \u2264 200 lines",
    requirement: "\u2265 10 fixes, \u2265 85% success rate",
  },
];

const STRESS_TESTS = [
  { name: "Webhook Storm", result: "p95 <400ms, 0% error" },
  { name: "MCP Rate Limits", result: "All 3 tiers enforced" },
  { name: "SSE Streaming", result: "50 connections stable" },
  { name: "Alert Dedup", result: "Accurate under load" },
  { name: "Auth Brute Force", result: "Rate limiting enforced" },
  { name: "Cron Fan-out", result: "No race conditions" },
  { name: "DB Saturation", result: "Neon stable at 400 q/s" },
  { name: "Push Pipeline", result: "Serial delivery stable" },
  { name: "Auto-Heal", result: "Single heal, cooldown works" },
  { name: "Full Incident", result: "10/10 phases, 100% checks" },
];

// ── Page ────────────────────────────────────────────────────────────────────

export default function TrustPage() {
  return (
    <div className="min-h-screen bg-page text-fg-base">
      <MarketingNav opaque />

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden pt-32 pb-24 sm:pt-40 sm:pb-32">
        <div className="absolute inset-0 bg-grid opacity-30" />
        <div className="absolute inset-0 bg-radial-fade" />

        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-4 py-1.5">
            <Shield className="h-3.5 w-3.5 text-inari-accent" />
            <span className="text-xs font-mono text-inari-accent tracking-wide">
              TRUST ARCHITECTURE
            </span>
          </div>

          <h1 className="text-4xl font-bold tracking-tight text-fg-strong sm:text-6xl lg:text-7xl leading-[1.05]">
            11 gates between
            <br />
            <span className="text-gradient-accent glow-accent-text">
              AI and your production.
            </span>
          </h1>

          <p className="mt-6 text-lg text-fg-base max-w-2xl mx-auto leading-relaxed">
            Auto-generated fixes on a misdiagnosed alert? That&apos;s what these
            gates prevent. 9 gates run on every fix out of the box. 2 more
            activate when you connect Substrate and Cortex infrastructure.
          </p>

          {/* Pipeline visualization */}
          <div className="mt-16 flex items-center justify-center gap-0 flex-wrap">
            {LAYERS.map((l, i) => (
              <div key={l.n} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5">
                  <div className={`h-9 w-9 sm:h-11 sm:w-11 rounded-full border flex items-center justify-center ${
                    l.alwaysOn
                      ? "border-inari-accent/40 bg-inari-accent/5"
                      : "border-dashed border-zinc-600 bg-zinc-800/30"
                  }`}>
                    <span className={`font-mono text-[10px] sm:text-xs font-bold ${
                      l.alwaysOn ? "text-inari-accent" : "text-zinc-500"
                    }`}>
                      {l.n}
                    </span>
                  </div>
                  <span className="text-[8px] sm:text-[9px] text-zinc-600 font-mono uppercase tracking-wider max-w-[60px] text-center leading-tight hidden sm:block">
                    {l.gate}
                  </span>
                </div>
                {i < LAYERS.length - 1 && (
                  <div className="w-3 sm:w-6 h-px bg-gradient-to-r from-inari-accent/40 to-inari-accent/10 mx-0.5" />
                )}
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-center gap-6 text-[10px] text-zinc-600 font-mono">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full border border-inari-accent/40 bg-inari-accent/5" />
              Always on
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full border border-dashed border-zinc-600 bg-zinc-800/30" />
              Activates with infrastructure
            </span>
          </div>
        </div>
      </section>

      {/* ── Layers ────────────────────────────────────────────────── */}
      {LAYERS.map((layer, i) => (
        <section
          key={layer.n}
          className={`relative border-t border-line-subtle ${
            i % 2 === 0 ? "bg-page" : "bg-surface"
          }`}
        >
          <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
            <div className="grid gap-12 lg:grid-cols-2 lg:gap-20 items-center">
              {/* Text side */}
              <div className={i % 2 === 1 ? "lg:order-2" : ""}>
                <div className="flex items-center gap-3 mb-6">
                  <span className="font-mono text-5xl sm:text-6xl font-bold text-fg-strong/[0.06] leading-none select-none">
                    {layer.n}
                  </span>
                  <div>
                    <p className="font-mono text-[10px] text-inari-accent tracking-[0.2em] uppercase">
                      Gate {layer.n}
                    </p>
                    <p className="font-mono text-xs text-zinc-500 uppercase tracking-wider">
                      {layer.gate}
                    </p>
                  </div>
                </div>

                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-fg-strong leading-tight">
                  {layer.headline}
                </h2>

                {!layer.alwaysOn && (
                  <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-dashed border-zinc-700 bg-zinc-800/30 px-3 py-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
                    <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                      Activates with infrastructure
                    </span>
                  </div>
                )}

                <p className="mt-4 text-sm text-fg-base leading-relaxed max-w-md">
                  {layer.detail}
                </p>
              </div>

              {/* Metric / Visual side */}
              <div className={`flex justify-center ${i % 2 === 1 ? "lg:order-1" : ""}`}>
                {layer.gate === "TRUST LEVELS" ? (
                  <TrustLevelVisual />
                ) : (
                  <MetricCard metric={layer.metric} label={layer.metricLabel} gate={layer.gate} alwaysOn={layer.alwaysOn} />
                )}
              </div>
            </div>
          </div>
        </section>
      ))}

      {/* ── Stress tested ────────────────────────────────────────── */}
      <section className="relative border-t border-line-subtle bg-page">
        <div className="mx-auto max-w-4xl px-6 py-24 sm:py-32">
          <p className="font-mono text-[10px] text-inari-accent tracking-[0.3em] uppercase mb-6 text-center">
            STRESS TESTED
          </p>
          <h2 className="text-2xl sm:text-4xl font-bold tracking-tight text-fg-strong text-center mb-4">
            10 scenarios. 10 passed.
          </h2>
          <p className="text-sm text-fg-base text-center max-w-2xl mx-auto mb-12">
            Every layer of the infrastructure is validated with k6 load tests against the production stack.
            Webhook storms, database saturation, concurrent SSE, brute force protection, and a full incident lifecycle — all passing.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {STRESS_TESTS.map((t) => (
              <div key={t.name} className="flex items-center justify-between rounded-lg border border-line bg-surface-dim px-4 py-3">
                <span className="text-sm text-fg-base">{t.name}</span>
                <span className="font-mono text-xs text-green-400">{t.result}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── The answer ────────────────────────────────────────────── */}
      <section className="relative border-t border-line-subtle bg-surface">
        <div className="absolute inset-0 bg-radial-fade opacity-50" />
        <div className="relative mx-auto max-w-4xl px-6 py-24 sm:py-32">
          <div className="text-center">
            <p className="font-mono text-[10px] text-inari-accent tracking-[0.3em] uppercase mb-6">
              THE ANSWER
            </p>
            <h2 className="text-3xl sm:text-5xl font-bold tracking-tight text-fg-strong leading-tight">
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
                body="The system builds a track record from actual remediation history. Fixes that pass CI, survive post-merge monitoring, and cause zero regressions count toward the next trust level. Regressions reset progress."
              />
              <AnswerBlock
                title="Even at maximum trust, all 11 gates must pass."
                body="If a single gate fails — low confidence, failed security scan, CI error, prediction risk too high, or too many lines changed — it falls back to a draft PR. Human decides."
              />
              <AnswerBlock
                title="Worst case: auto-revert in 10 minutes."
                body="If a fix somehow passes all gates and causes a new error in production, the post-merge monitor auto-reverts the change and escalates to your on-call team."
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Comparison ────────────────────────────────────────────── */}
      <section className="border-t border-line-subtle bg-page">
        <div className="mx-auto max-w-4xl px-6 py-24 sm:py-32">
          <p className="font-mono text-[10px] text-zinc-500 tracking-[0.3em] uppercase mb-8 text-center">
            PERSPECTIVE
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="rounded-xl border border-red-300/30 dark:border-red-900/30 bg-red-50 dark:bg-red-950/10 p-6">
              <p className="font-mono text-xs text-red-600/70 dark:text-red-400/70 uppercase tracking-wider mb-3">
                Dev hotfix at 3 AM
              </p>
              <ul className="space-y-2 text-sm text-fg-base">
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
                  No security scan
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
              <ul className="space-y-2 text-sm text-fg-base">
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  36-check security scan on every fix
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  AI self-review (score + recommendation)
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  Full CI must pass (3 retries)
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  Pre-deploy prediction engine
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  10-min post-merge monitor + auto-revert
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-inari-accent mt-0.5">+</span>
                  Consistent process, always — earned trust levels
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────── */}
      <section className="border-t border-line-subtle bg-surface">
        <div className="relative mx-auto max-w-4xl px-6 py-24 sm:py-32 text-center">
          <div className="absolute inset-0 bg-radial-fade opacity-30" />
          <div className="relative">
            <h2 className="text-2xl sm:text-4xl font-bold tracking-tight text-fg-strong">
              Safer than your 3 AM hotfix.
            </h2>
            <p className="mt-4 text-fg-base max-w-lg mx-auto">
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
                  className="px-8 py-3 border-line-medium text-fg-base hover:text-fg-strong hover:border-line"
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
  alwaysOn = true,
}: {
  metric: string;
  label: string;
  gate: string;
  alwaysOn?: boolean;
}) {
  return (
    <div className="relative w-full max-w-[280px]">
      <div className={`aspect-square rounded-2xl border p-6 flex flex-col items-center justify-center text-center ${
        alwaysOn ? "border-line bg-surface-dim" : "border-dashed border-zinc-700 bg-zinc-900/30"
      }`}>
        <p className={`font-mono text-5xl sm:text-6xl font-bold tracking-tight ${
          alwaysOn ? "text-fg-strong" : "text-zinc-500"
        }`}>
          {metric}
        </p>
        <p className="mt-2 font-mono text-xs text-zinc-500 uppercase tracking-wider">
          {label}
        </p>
        <div className={`mt-4 h-px w-12 ${alwaysOn ? "bg-inari-accent/30" : "bg-zinc-700"}`} />
        <p className={`mt-3 font-mono text-[10px] uppercase tracking-[0.15em] ${
          alwaysOn ? "text-inari-accent/50" : "text-zinc-600"
        }`}>
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
            <p className="text-[10px] text-zinc-700 font-mono mt-0.5">
              {t.requirement}
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
      <p className="text-sm font-semibold text-fg-strong">{title}</p>
      <p className="mt-1 text-sm text-fg-base leading-relaxed">{body}</p>
    </div>
  );
}
