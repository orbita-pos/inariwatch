"use client";

import { useState, useEffect } from "react";

// ── Data ─────────────────────────────────────────────────────────────────────

const ALERTS = [
  { id: 0, level: "critical", title: "TypeError: Cannot read properties of undefined", source: "capture", time: "2m",  status: "fixing", file: "app/checkout/page.tsx:47",          diagnosis: "Null dereference on cart object. Triggered when user navigates directly to /checkout with an empty session — cart is undefined before the guard check runs." },
  { id: 1, level: "error",    title: "Build failed · type error in checkout flow",      source: "vercel", time: "8m",  status: "fixed",  file: "components/CartSummary.tsx:12",     diagnosis: "Type mismatch: CartItem.price received as string, expected number. Introduced in commit 3f2a91c. Stripe SDK returns strings for monetary values." },
  { id: 2, level: "warning",  title: "P99 latency spike · /api/users endpoint",         source: "datadog",time: "14m", status: "open",   file: "app/api/users/route.ts:31",          diagnosis: "Missing index on users.email causes a full table scan under load. P99 spiked from 38ms to 340ms after user base crossed 50k rows." },
  { id: 3, level: "error",    title: "Unhandled rejection · payment webhook",            source: "sentry", time: "28m", status: "fixed",  file: "app/api/webhooks/stripe/route.ts:88",diagnosis: "Promise rejection from stripe.webhooks.constructEvent not caught. Handler exits without sending 200 — Stripe retries the event 72 times." },
  { id: 4, level: "info",     title: "npm audit · 2 moderate CVEs detected",            source: "npm",    time: "1h",  status: "open",   file: "package.json",                       diagnosis: "CVE-2024-4067 in micromatch@4.0.5 (ReDoS via backtracking) and CVE-2024-28849 in follow-redirects@1.15.5 (credential leak on redirect)." },
] as const;

type AlertItem = (typeof ALERTS)[number];

const PROJECTS = [
  { name: "myapp",       env: "prod",    dot: "bg-emerald-400", status: "healthy",        last: "deployed 2m" },
  { name: "api-service", env: "prod",    dot: "bg-emerald-400", status: "healthy",        last: "deployed 1h" },
  { name: "checkout",    env: "staging", dot: "bg-yellow-400",  status: "building",       last: "push 4m ago" },
  { name: "mobile-app",  env: "prod",    dot: "bg-red-500",     status: "deploy failed",  last: "failed 12m"  },
  { name: "docs",        env: "prod",    dot: "bg-emerald-400", status: "healthy",        last: "deployed 3h" },
] as const;

const ONCALL = [
  { name: "Alex Chen",   role: "primary", shift: "until Sun",  avatar: "AC" },
  { name: "Maria Lopez", role: "next",    shift: "Mon–Sun",    avatar: "ML" },
  { name: "David Kim",   role: "standby", shift: "standby",   avatar: "DK" },
] as const;

const CHART_BARS = [
  { day: "M", h: 28, crit: 1 }, { day: "T", h: 55, crit: 2 },
  { day: "W", h: 92, crit: 3 }, { day: "T", h: 38, crit: 1 },
  { day: "F", h: 70, crit: 2 }, { day: "S", h: 18, crit: 0 },
  { day: "S", h: 30, crit: 1 },
] as const;

const CHAT = [
  { role: "ai",   text: "Hey! Ask me anything about your alerts, deployments, or on-call." },
  { role: "user", text: "What's causing the most noise this week?" },
  { role: "ai",   text: "The checkout flow — 3 critical errors, all null-dereference on cart state. Also a P99 spike on /api/users (missing index). I can fix both now if you want." },
] as const;

const FIX_STEPS = [
  "Reading error context…",
  "Scanning relevant files…",
  "Generating fix…",
  "Running type check…",
  "Opening PR #247…",
];

const NAV_ITEMS = ["Alerts", "Projects", "On-call", "Analytics", "Chat"] as const;
type NavItem = (typeof NAV_ITEMS)[number];

// ── Helpers ───────────────────────────────────────────────────────────────────

function dot(level: string) {
  if (level === "critical") return "bg-red-500";
  if (level === "error")    return "bg-orange-400";
  if (level === "warning")  return "bg-yellow-400";
  return "bg-blue-400";
}

function statusLabel(status: string) {
  if (status === "fixing") return { text: "AI fixing…", cls: "text-orange-400/90" };
  if (status === "fixed")  return { text: "fixed ✓",   cls: "text-emerald-400/80" };
  return { text: "open", cls: "text-white/22" };
}

// ── Sub-panel views ────────────────────────────────────────────────────────────

function ProjectsPanel() {
  const [hovered, setHovered] = useState<number | null>(null);
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-3 h-7 border-b border-white/[0.04] shrink-0">
        <span className="text-[9px] uppercase tracking-widest text-white/15 flex-1">Project</span>
        <span className="text-[9px] uppercase tracking-widest text-white/15 w-14 text-right">Env</span>
        <span className="text-[9px] uppercase tracking-widest text-white/15 w-20 text-right">Status</span>
        <span className="text-[9px] uppercase tracking-widest text-white/15 w-20 text-right">Last event</span>
      </div>
      {PROJECTS.map((p, i) => (
        <div
          key={i}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
          className={`flex items-center gap-2.5 px-3 h-[46px] border-b border-white/[0.04] cursor-default transition-colors duration-100 ${
            hovered === i ? "bg-white/[0.025]" : ""
          }`}
        >
          <span className={`h-[5px] w-[5px] rounded-full shrink-0 ${p.dot}`} />
          <span className="flex-1 text-[11px] text-white/55 font-mono truncate">{p.name}</span>
          <span className="w-14 text-right text-[9px] font-mono text-white/22 shrink-0">{p.env}</span>
          <span className={`w-20 text-right text-[9px] font-medium shrink-0 ${
            p.status === "deploy failed" ? "text-red-400/80" :
            p.status === "building"      ? "text-yellow-400/80" :
            "text-emerald-400/70"
          }`}>{p.status}</span>
          <span className="w-20 text-right text-[9px] text-white/18 shrink-0">{p.last}</span>
        </div>
      ))}
    </div>
  );
}

function OncallPanel() {
  return (
    <div className="flex flex-col h-full px-4 py-3 gap-4">
      <div>
        <p className="text-[9px] uppercase tracking-widest text-white/18 mb-2.5">Current rotation — Week 17</p>
        <div className="space-y-1.5">
          {ONCALL.map((p, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <div className="h-6 w-6 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0">
                <span className="text-[8px] font-mono text-white/40">{p.avatar}</span>
              </div>
              <span className="text-[11px] text-white/55 flex-1">{p.name}</span>
              <span className={`text-[9px] font-medium ${
                p.role === "primary" ? "text-orange-400/80" :
                p.role === "next"    ? "text-white/30" :
                "text-white/18"
              }`}>{p.shift}</span>
              {p.role === "primary" && (
                <span className="h-1.5 w-1.5 rounded-full bg-orange-400 animate-pulse" />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-white/[0.04] pt-3.5">
        <p className="text-[9px] uppercase tracking-widest text-white/18 mb-2">Escalation policy</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {["Slack DM", "→ 5m →", "PagerDuty", "→ 15m →", "SMS"].map((s, i) => (
            <span key={i} className={`text-[9px] ${
              s.startsWith("→") ? "text-white/18" :
              i === 0 ? "font-mono text-white/35 bg-white/[0.05] rounded px-1.5 py-0.5" :
              "font-mono text-white/35 bg-white/[0.05] rounded px-1.5 py-0.5"
            }`}>{s}</span>
          ))}
        </div>
      </div>
      <div className="border-t border-white/[0.04] pt-3.5">
        <p className="text-[9px] uppercase tracking-widest text-white/18 mb-2">Next override</p>
        <p className="text-[10px] text-white/30">No overrides scheduled</p>
      </div>
    </div>
  );
}

function AnalyticsPanel() {
  return (
    <div className="flex flex-col h-full px-4 py-3">
      {/* Stat chips */}
      <div className="flex items-center gap-3 mb-4">
        {[
          { label: "MTTR", value: "4m", sub: "↓ 18%" },
          { label: "Resolved", value: "21", sub: "this week" },
          { label: "Uptime", value: "99.8%", sub: "30d avg" },
        ].map((s) => (
          <div key={s.label} className="flex-1 rounded-md bg-white/[0.04] border border-white/[0.05] px-2 py-1.5">
            <p className="text-[9px] text-white/25 uppercase tracking-wider">{s.label}</p>
            <p className="text-[13px] font-semibold text-white/60 leading-tight">{s.value}</p>
            <p className="text-[8px] text-emerald-400/55">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="flex-1">
        <p className="text-[9px] uppercase tracking-widest text-white/18 mb-2">Alerts · last 7 days</p>
        <div className="flex items-end gap-1.5 h-[76px]">
          {CHART_BARS.map((b, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full flex flex-col justify-end rounded-sm overflow-hidden" style={{ height: 64 }}>
                <div
                  className="w-full rounded-sm transition-all duration-500"
                  style={{
                    height: `${b.h}%`,
                    background: b.crit > 1
                      ? "rgba(249,115,22,0.45)"
                      : b.crit === 1
                      ? "rgba(249,115,22,0.28)"
                      : "rgba(255,255,255,0.08)",
                  }}
                />
              </div>
              <span className="text-[8px] text-white/18">{b.day}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-2 pt-2 border-t border-white/[0.04]">
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-sm bg-orange-400/70" />
          <span className="text-[8px] text-white/20">critical</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-sm bg-white/[0.2]" />
          <span className="text-[8px] text-white/20">other</span>
        </div>
        <span className="ml-auto text-[8px] text-white/14">23 total</span>
      </div>
    </div>
  );
}

function ChatPanel() {
  const [typing, setTyping] = useState(false);
  const [sent, setSent] = useState(false);

  function handleAsk() {
    if (sent) return;
    setSent(true);
    setTyping(true);
    setTimeout(() => setTyping(false), 1800);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 px-3 py-2.5 flex flex-col gap-2 overflow-hidden">
        {CHAT.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            style={{ animation: `card-in 0.25s ease ${i * 0.08}s both` }}
          >
            <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[10px] leading-relaxed ${
              m.role === "user"
                ? "bg-orange-500/15 text-white/60 rounded-br-sm"
                : "bg-white/[0.05] text-white/45 rounded-bl-sm"
            }`}>
              {m.text}
            </div>
          </div>
        ))}
        {typing && (
          <div className="flex justify-start" style={{ animation: "card-in 0.2s ease both" }}>
            <div className="bg-white/[0.05] rounded-lg rounded-bl-sm px-3 py-2 flex items-center gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1 w-1 rounded-full bg-white/30"
                  style={{ animation: `fade-in 0.6s ease ${i * 0.2}s infinite alternate` }}
                />
              ))}
            </div>
          </div>
        )}
        {sent && !typing && (
          <div className="flex justify-start" style={{ animation: "card-in 0.25s ease both" }}>
            <div className="max-w-[85%] bg-white/[0.05] text-white/45 rounded-lg rounded-bl-sm px-2.5 py-1.5 text-[10px] leading-relaxed">
              Rollback is available — last good deploy was <span className="font-mono text-orange-400/70">v1.4.2</span> at 10:41 UTC. Want me to trigger it?
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-3 pb-3 shrink-0">
        <button
          onClick={handleAsk}
          disabled={sent}
          className={`w-full flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 h-8 text-left transition-colors ${
            sent ? "opacity-40 cursor-default" : "hover:bg-white/[0.05] cursor-pointer"
          }`}
        >
          <span className="text-[10px] text-white/20 flex-1 truncate">
            {sent ? "Ask Inari anything…" : "Should I rollback the checkout deploy?"}
          </span>
          {!sent && (
            <span className="text-[9px] text-orange-400/50 shrink-0">↵ send</span>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Status bar content per tab ────────────────────────────────────────────────

const STATUS_BAR: Record<NavItem, React.ReactNode> = {
  Alerts: (
    <>
      <span className="text-[9px] text-white/22">5 open</span>
      <span className="text-white/10">·</span>
      <span className="text-[9px] text-white/22">2 fixed today</span>
      <div className="ml-auto flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/60" />
        <span className="text-[9px] text-white/18">all systems normal</span>
      </div>
    </>
  ),
  Projects: (
    <>
      <span className="text-[9px] text-white/22">5 projects</span>
      <span className="text-white/10">·</span>
      <span className="text-[9px] text-red-400/60">1 failed deploy</span>
      <span className="ml-auto text-[9px] text-white/18">4 healthy</span>
    </>
  ),
  "On-call": (
    <>
      <span className="h-1.5 w-1.5 rounded-full bg-orange-400 animate-pulse" />
      <span className="text-[9px] text-white/22">Alex Chen on-call</span>
      <span className="ml-auto text-[9px] text-white/18">rotates Sunday</span>
    </>
  ),
  Analytics: (
    <>
      <span className="text-[9px] text-white/22">last 7 days</span>
      <span className="text-white/10">·</span>
      <span className="text-[9px] text-emerald-400/60">MTTR ↓ 18%</span>
      <span className="ml-auto text-[9px] text-white/18">99.8% uptime</span>
    </>
  ),
  Chat: (
    <>
      <span className="h-1.5 w-1.5 rounded-full bg-orange-400/80 animate-pulse" />
      <span className="text-[9px] font-mono text-orange-400/60">Ask Inari</span>
    </>
  ),
};

// ── Main component ─────────────────────────────────────────────────────────────

export function MiniDashboard() {
  const [activeNav, setActiveNav] = useState<NavItem>("Alerts");
  const [selected, setSelected] = useState<number | null>(null);
  const [fixPhase, setFixPhase] = useState<"idle" | "running" | "done">("idle");
  const [fixStep, setFixStep] = useState(0);

  const activeAlert: AlertItem | null = selected !== null ? ALERTS[selected] : null;

  function switchNav(nav: NavItem) {
    setActiveNav(nav);
    setSelected(null);
    setFixPhase("idle");
    setFixStep(0);
  }

  function pickRow(id: number) {
    if (selected === id) { setSelected(null); resetFix(); }
    else                  { setSelected(id);  resetFix(); }
  }

  function resetFix() {
    setFixPhase("idle");
    setFixStep(0);
  }

  function startFix() {
    if (fixPhase !== "idle") return;
    setFixPhase("running");
    setFixStep(0);
  }

  useEffect(() => {
    if (fixPhase !== "running") return;
    if (fixStep >= FIX_STEPS.length) { setFixPhase("done"); return; }
    const t = setTimeout(() => setFixStep((s) => s + 1), 650);
    return () => clearTimeout(t);
  }, [fixPhase, fixStep]);

  const panelOpen = activeAlert !== null;

  return (
    <div
      className="w-full rounded-xl overflow-hidden border border-white/[0.07] select-none"
      style={{
        background: "#0e0e11",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.04), 0 32px 80px rgba(0,0,0,0.55), 0 0 100px rgba(249,115,22,0.05)",
      }}
    >
      {/* Window chrome */}
      <div className="flex items-center h-9 px-3.5 bg-[#0b0b0e] border-b border-white/[0.05]">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/70" />
        </div>
        <div className="mx-auto flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-white/25">InariWatch</span>
          <span className="text-white/15 text-[10px]">·</span>
          <span className="text-[10px] font-mono text-white/20">myapp</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex" style={{ height: 348 }}>

        {/* Sidebar */}
        <nav className="w-[116px] shrink-0 border-r border-white/[0.05] py-3 px-1.5 flex flex-col gap-0.5">
          {NAV_ITEMS.map((label) => (
            <button
              key={label}
              onClick={() => switchNav(label)}
              className={`w-full flex items-center justify-between px-2.5 py-[7px] rounded-md text-[11px] text-left transition-colors duration-100 ${
                activeNav === label
                  ? "bg-white/[0.07] text-white/70"
                  : "text-white/22 hover:bg-white/[0.035] hover:text-white/40"
              }`}
            >
              <span>{label}</span>
              {label === "Alerts" && (
                <span className="text-[9px] font-mono rounded px-1 py-px bg-orange-500/20 text-orange-400/80">
                  5
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Main panel */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Toolbar */}
          <div className="flex items-center h-9 px-4 border-b border-white/[0.05] shrink-0">
            <span className="text-[11px] font-semibold text-white/50">{activeNav}</span>
            {activeNav === "Alerts" && (
              <div className="ml-auto flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-400/80 animate-pulse" />
                  <span className="text-[9px] font-mono text-orange-400/70">AI active</span>
                </div>
                <span className="text-[9px] text-white/20">MTTR&nbsp;<span className="font-mono text-white/35">4m</span></span>
              </div>
            )}
            {activeNav === "Projects" && (
              <div className="ml-auto flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500/70" />
                <span className="text-[9px] text-red-400/60">1 needs attention</span>
              </div>
            )}
            {activeNav === "On-call" && (
              <div className="ml-auto flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-orange-400 animate-pulse" />
                <span className="text-[9px] text-white/25">Week 17</span>
              </div>
            )}
            {activeNav === "Analytics" && (
              <span className="ml-auto text-[9px] text-white/20">last 7 days</span>
            )}
          </div>

          {/* Content */}
          <div className="flex flex-1 overflow-hidden">

            {/* ── Alerts view ── */}
            {activeNav === "Alerts" && (
              <div className="relative flex-1 overflow-hidden">

                {/* Alert list — always full width, never resizes */}
                <div className="flex flex-col h-full">
                  <div className="flex items-center px-3 h-7 border-b border-white/[0.04] shrink-0">
                    <span className="text-[9px] uppercase tracking-widest text-white/15 flex-1">Title</span>
                    <span className="text-[9px] uppercase tracking-widest text-white/15 w-12 text-right">Source</span>
                    <span className="text-[9px] uppercase tracking-widest text-white/15 w-8 text-right">Age</span>
                    <span className="text-[9px] uppercase tracking-widest text-white/15 w-16 text-right">Status</span>
                  </div>
                  {ALERTS.map((a, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => pickRow(i)}
                      aria-pressed={selected === i}
                      aria-label={`${a.level} alert: ${a.title}`}
                      className={`relative flex items-center gap-2 px-3 h-[46px] w-full text-left border-b border-white/[0.04] cursor-pointer transition-colors duration-100 ${
                        selected === i
                          ? "bg-orange-500/[0.08]"
                          : i === 0
                          ? "bg-orange-500/[0.025] hover:bg-white/[0.025]"
                          : "hover:bg-white/[0.025]"
                      }`}
                    >
                      {selected === i && (
                        <span className="absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-r-full bg-orange-500/70" aria-hidden="true" />
                      )}
                      <span className={`h-[5px] w-[5px] rounded-full shrink-0 ${dot(a.level)}`} aria-hidden="true" />
                      <span className={`flex-1 text-[11px] truncate transition-colors duration-100 ${
                        selected === i ? "text-white/80" : "text-white/50"
                      }`}>{a.title}</span>
                      <span className="w-12 text-right text-[9px] font-mono text-white/22 shrink-0">{a.source}</span>
                      <span className="w-8 text-right text-[9px] text-white/18 shrink-0">{a.time}</span>
                      <span className={`w-16 text-right text-[9px] font-medium shrink-0 ${statusLabel(a.status).cls}`}>
                        {statusLabel(a.status).text}
                      </span>
                    </button>
                  ))}
                </div>

                {/* Detail panel — absolute overlay, slides in from right */}
                {panelOpen && activeAlert && (
                  <div
                    className="absolute inset-0 flex flex-col bg-[#0d0d10] border-l border-white/[0.06]"
                    style={{ animation: "slide-from-right 0.2s ease both" }}
                  >
                    {/* Header */}
                    <div className="px-3 pt-2.5 pb-2 border-b border-white/[0.05] shrink-0">
                      <div className="flex items-start gap-1.5">
                        <span className={`mt-[3px] h-[5px] w-[5px] rounded-full shrink-0 ${dot(activeAlert.level)}`} />
                        <p className="text-[10.5px] text-white/75 leading-snug line-clamp-2">{activeAlert.title}</p>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[9px] font-mono text-white/30 bg-white/[0.06] rounded px-1.5 py-0.5">{activeAlert.source}</span>
                        <span className="text-[9px] text-white/20">{activeAlert.time} ago</span>
                        <span className="text-[9px] font-mono text-white/18 truncate max-w-[140px]">{activeAlert.file}</span>
                      </div>
                    </div>

                    {/* Diagnosis */}
                    <div className="flex-1 px-3 py-2.5 overflow-hidden flex flex-col">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-orange-400/60" />
                        <span className="text-[9px] font-mono text-orange-400/55 uppercase tracking-wider">AI Diagnosis</span>
                      </div>
                      <p className="text-[10px] text-white/40 leading-relaxed">{activeAlert.diagnosis}</p>

                      {/* Fix steps */}
                      {fixPhase !== "idle" && (
                        <div className="mt-2.5 space-y-1">
                          {FIX_STEPS.slice(0, fixStep).map((step, i) => (
                            <div key={i} className="flex items-center gap-1.5" style={{ animation: "card-in 0.25s ease both" }}>
                              <span className="text-[9px] text-emerald-400/70">✓</span>
                              <span className="text-[9px] text-white/30">{step}</span>
                            </div>
                          ))}
                          {fixPhase === "running" && fixStep < FIX_STEPS.length && (
                            <div className="flex items-center gap-1.5">
                              <span className="h-1 w-1 rounded-full bg-orange-400 animate-pulse" />
                              <span className="text-[9px] text-orange-400/65">{FIX_STEPS[fixStep]}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="px-3 pb-3 pt-1 flex items-center gap-2 shrink-0">
                      {fixPhase === "done" ? (
                        <span className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-medium bg-emerald-500/15 text-emerald-400">
                          PR #247 opened ✓
                        </span>
                      ) : (
                        <button
                          onClick={startFix}
                          disabled={fixPhase === "running"}
                          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-all ${
                            fixPhase === "running"
                              ? "bg-orange-500/15 text-orange-400/50 cursor-wait"
                              : "bg-orange-500/20 text-orange-400 hover:bg-orange-500/30"
                          }`}
                        >
                          {fixPhase === "running"
                            ? <><span className="h-1 w-1 rounded-full bg-orange-400 animate-pulse" />Fixing…</>
                            : "Fix it"}
                        </button>
                      )}
                      <button
                        onClick={() => { setSelected(null); resetFix(); }}
                        className="text-[10px] text-white/20 hover:text-white/40 transition-colors px-1.5 py-1.5"
                      >
                        ← back
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Other views ── */}
            {activeNav === "Projects"  && <div className="flex-1 overflow-hidden" style={{ animation: "card-in 0.2s ease both" }}><ProjectsPanel /></div>}
            {activeNav === "On-call"   && <div className="flex-1 overflow-hidden" style={{ animation: "card-in 0.2s ease both" }}><OncallPanel /></div>}
            {activeNav === "Analytics" && <div className="flex-1 overflow-hidden" style={{ animation: "card-in 0.2s ease both" }}><AnalyticsPanel /></div>}
            {activeNav === "Chat"      && <div className="flex-1 overflow-hidden" style={{ animation: "card-in 0.2s ease both" }}><ChatPanel /></div>}
          </div>

          {/* Status bar */}
          <div className="flex items-center px-4 h-8 border-t border-white/[0.05] bg-[#0b0b0e] shrink-0 gap-2">
            {STATUS_BAR[activeNav]}
          </div>
        </div>
      </div>
    </div>
  );
}
