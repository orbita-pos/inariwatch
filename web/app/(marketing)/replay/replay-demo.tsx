"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw, GitPullRequest, AlertCircle, Gauge, MousePointerClick, Sparkles } from "lucide-react";

// ── Event timeline ────────────────────────────────────────────────────────────
// Total session: 30 seconds (compressed for demo). Each event has a `t` in
// seconds. Components render based on the current `time` cursor.

type EventKind = "nav" | "click" | "input" | "console" | "network" | "rage" | "dead" | "error" | "vital";
interface Event {
  t: number;
  kind: EventKind;
  label: string;
  detail?: string;
  level?: "info" | "warn" | "error";
}

const EVENTS: Event[] = [
  { t: 0.5,  kind: "nav",     label: "/products" },
  { t: 1.2,  kind: "console", label: "page view tracked", level: "info" },
  { t: 2.0,  kind: "network", label: "GET /api/products → 200", detail: "120ms" },
  { t: 4.0,  kind: "click",   label: "Add to cart" },
  { t: 4.5,  kind: "network", label: "POST /api/cart → 200", detail: "84ms" },
  { t: 6.0,  kind: "nav",     label: "/checkout" },
  { t: 7.5,  kind: "vital",   label: "LCP slow", detail: "3.2s" },
  { t: 9.0,  kind: "input",   label: "Email entered", detail: "*** masked" },
  { t: 11.0, kind: "click",   label: "Continue" },
  { t: 12.0, kind: "network", label: "GET /api/order → 200", detail: "210ms" },
  { t: 14.0, kind: "click",   label: "Pay now" },
  { t: 14.4, kind: "rage",    label: "Rage cluster · 3 clicks in 600ms" },
  { t: 14.5, kind: "click",   label: "Pay now" },
  { t: 14.7, kind: "click",   label: "Pay now" },
  { t: 15.0, kind: "error",   label: "TypeError: Cannot read 'total' of undefined", detail: "checkout/page.tsx:47" },
  { t: 15.1, kind: "console", label: "TypeError thrown — checkout/page.tsx:47", level: "error" },
  { t: 15.4, kind: "network", label: "POST /api/pay → 500", detail: "32ms" },
  { t: 18.0, kind: "click",   label: "Help" },
  { t: 21.0, kind: "dead",    label: "Dead click — no DOM mutation" },
  { t: 24.0, kind: "click",   label: "Help" },
  { t: 25.0, kind: "console", label: "user exited page", level: "warn" },
  { t: 30.0, kind: "nav",     label: "session ended" },
];

const FIX_STEPS = [
  "Reading replay context…",
  "Diagnosing root cause…",
  "Reading checkout/page.tsx…",
  "Generating fix…",
  "Running 11 safety gates…",
  "Opening PR #4821…",
];

const DURATION = 30;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(t: number): string {
  const total = Math.max(0, Math.min(DURATION, t));
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function eventsBefore(time: number, kind?: EventKind): Event[] {
  return EVENTS.filter((e) => e.t <= time && (!kind || e.kind === kind));
}

// ── Stage (the "screen" the user sees) ────────────────────────────────────────

function MockStage({ time }: { time: number }) {
  // Choose what to render based on time
  const isCheckout = time >= 6;
  const hasError = time >= 15;
  const ragePulse = time >= 14 && time <= 16;
  const lcpSlow = time >= 7.5;

  return (
    <div className="relative aspect-video bg-gradient-to-br from-[#1a1a1f] to-[#0f0f12] overflow-hidden">
      {/* Faux browser content */}
      <div className="absolute inset-0 p-6 flex flex-col">
        {/* Faux nav */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="h-3 w-16 rounded bg-white/10" />
            <div className="h-2 w-12 rounded bg-white/[0.06]" />
            <div className="h-2 w-12 rounded bg-white/[0.06]" />
          </div>
          <div className="h-6 w-20 rounded-full bg-white/[0.06] flex items-center justify-center">
            <div className="h-2 w-10 rounded bg-white/15" />
          </div>
        </div>

        {!isCheckout ? (
          // Products grid
          <div className="grid grid-cols-3 gap-3 flex-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-md bg-white/[0.04] border border-white/[0.06] p-2.5 flex flex-col gap-2">
                <div className={`flex-1 rounded ${lcpSlow && i === 0 ? "bg-amber-500/10" : "bg-white/[0.04]"}`} style={{ minHeight: 40 }} />
                <div className="h-1.5 w-3/4 rounded bg-white/10" />
                <div className="h-1.5 w-1/2 rounded bg-white/[0.08]" />
              </div>
            ))}
          </div>
        ) : (
          // Checkout form
          <div className="flex-1 max-w-[280px] space-y-3">
            <div className="h-3 w-24 rounded bg-white/15 mb-4" />
            <div className="space-y-2">
              <div className="h-2 w-12 rounded bg-white/[0.08]" />
              <div className="h-7 rounded border border-white/[0.08] bg-white/[0.03]" />
            </div>
            <div className="space-y-2">
              <div className="h-2 w-16 rounded bg-white/[0.08]" />
              <div className="h-7 rounded border border-white/[0.08] bg-white/[0.03] flex items-center px-2">
                <div className="h-2 w-32 rounded bg-white/15" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-2 w-14 rounded bg-white/[0.08]" />
              <div className="h-7 rounded border border-white/[0.08] bg-white/[0.03]" />
            </div>
            {/* Pay button — lights up red on rage burst */}
            <div className="pt-2 relative">
              <div
                className={`h-9 rounded-md flex items-center justify-center text-[11px] font-medium transition-colors duration-150 ${
                  hasError
                    ? "bg-red-500/20 text-red-400 border border-red-500/40"
                    : "bg-inari-accent text-white"
                }`}
              >
                {hasError ? "Try again" : "Pay now"}
              </div>
              {ragePulse && (
                <>
                  <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 animate-ping" />
                  <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500/80" />
                </>
              )}
            </div>

            {hasError && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 flex items-start gap-2" style={{ animation: "card-in 0.25s ease both" }}>
                <AlertCircle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-px" />
                <span className="text-[10px] text-red-300 leading-snug">Something went wrong — please try again.</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Frustration markers overlay */}
      {time >= 14.7 && (
        <>
          <span className="absolute" style={{ top: "62%", left: "38%" }}>
            <span className="h-2.5 w-2.5 rounded-sm bg-red-500 block" title="Rage" />
          </span>
          <span className="absolute" style={{ top: "62%", left: "42%" }}>
            <span className="h-2.5 w-2.5 rounded-sm bg-red-500 block" />
          </span>
          <span className="absolute" style={{ top: "62%", left: "46%" }}>
            <span className="h-2.5 w-2.5 rounded-sm bg-red-500 block" />
          </span>
        </>
      )}
      {time >= 21 && (
        <span className="absolute" style={{ top: "20%", right: "8%" }}>
          <span className="h-2.5 w-2.5 rounded-sm border-2 border-red-500 block" title="Dead click" />
        </span>
      )}
    </div>
  );
}

// ── Side panels ───────────────────────────────────────────────────────────────

type Tab = "console" | "network" | "nav";

function ConsolePanel({ time }: { time: number }) {
  const items = eventsBefore(time).filter((e) => e.kind === "console" || e.kind === "click" || e.kind === "input" || e.kind === "error");
  const recent = items.slice(-9);
  return (
    <div className="space-y-1.5 font-mono text-[10.5px]">
      {recent.length === 0 ? (
        <p className="text-white/30 italic">Press play to start the session…</p>
      ) : (
        recent.map((e, i) => {
          const cls =
            e.kind === "error" ? "text-red-400" :
            e.level === "warn" ? "text-amber-400" :
            e.level === "info" ? "text-white/45" :
            e.kind === "click" ? "text-white/45" :
            "text-white/45";
          const tag = e.kind === "error" ? "error" : e.kind === "click" ? "click" : e.kind === "input" ? "input" : e.level ?? "log";
          return (
            <div key={`${e.t}-${i}`} className={`leading-snug ${cls}`} style={{ animation: "card-in 0.2s ease both" }}>
              <span className="text-white/25">[{fmtTime(e.t)}]</span>{" "}
              <span className="text-white/35">{tag}</span>{" — "}{e.label}
            </div>
          );
        })
      )}
    </div>
  );
}

function NetworkPanel({ time }: { time: number }) {
  const items = eventsBefore(time, "network");
  return (
    <div className="space-y-1.5 font-mono text-[10.5px]">
      {items.length === 0 ? (
        <p className="text-white/30 italic">No requests yet.</p>
      ) : (
        items.map((e, i) => {
          const failed = e.label.includes("500") || e.label.includes("→ 5");
          return (
            <div key={i} className="flex items-center gap-2 leading-snug" style={{ animation: "card-in 0.2s ease both" }}>
              <span className="text-white/25 w-10 shrink-0">{fmtTime(e.t)}</span>
              <span className={`flex-1 truncate ${failed ? "text-red-400" : "text-white/55"}`}>{e.label}</span>
              <span className="text-white/30 shrink-0">{e.detail}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

function NavPanel({ time }: { time: number }) {
  const items = eventsBefore(time, "nav");
  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="font-mono text-[10.5px] text-white/30 italic">No navigations yet.</p>
      ) : (
        items.map((e, i) => (
          <div key={i} className="flex items-center gap-2" style={{ animation: "card-in 0.2s ease both" }}>
            <span className="font-mono text-[10px] text-white/25 w-10 shrink-0">{fmtTime(e.t)}</span>
            <span className="font-mono text-[11px] text-white/55 truncate rounded-md bg-white/[0.05] px-2 py-0.5 border border-white/[0.06]">
              {e.label}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ── Main demo ─────────────────────────────────────────────────────────────────

export function ReplayDemo() {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [tab, setTab] = useState<Tab>("console");
  const [fixPhase, setFixPhase] = useState<"idle" | "running" | "done">("idle");
  const [fixStep, setFixStep] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  // Auto-start once when in viewport (simple: start on mount with a small delay)
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    const t = setTimeout(() => setPlaying(true), 600);
    return () => clearTimeout(t);
  }, []);

  // Playback loop (rAF for smoothness, but in test envs falls back gracefully)
  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = performance.now();

    function tick(now: number) {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      setTime((prev) => {
        const next = prev + dt * speed;
        if (next >= DURATION) {
          setPlaying(false);
          return DURATION;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speed]);

  // Fix progression
  useEffect(() => {
    if (fixPhase !== "running") return;
    if (fixStep >= FIX_STEPS.length) {
      setFixPhase("done");
      return;
    }
    const t = setTimeout(() => setFixStep((s) => s + 1), 700);
    return () => clearTimeout(t);
  }, [fixPhase, fixStep]);

  function togglePlay() {
    if (time >= DURATION) {
      setTime(0);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  }
  function reset() {
    setPlaying(false);
    setTime(0);
  }
  function startFix() {
    if (fixPhase !== "idle") return;
    setFixPhase("running");
    setFixStep(0);
  }

  const errorVisible = time >= 15;
  const lcpVisible = time >= 7.5;
  const rageVisible = time >= 14.7;
  const deadVisible = time >= 21;
  const aiVisible = time >= 18;

  const errorCount = useMemo(() => eventsBefore(time, "error").length, [time]);
  const rageCount = useMemo(() => eventsBefore(time, "rage").length, [time]);
  const deadCount = useMemo(() => eventsBefore(time, "dead").length, [time]);

  const progress = (time / DURATION) * 100;

  return (
    <div
      className="w-full rounded-2xl overflow-hidden border border-white/[0.07] select-none"
      style={{
        background: "#0e0e11",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.04), 0 32px 80px rgba(0,0,0,0.55), 0 0 100px rgba(249,115,22,0.05)",
      }}
    >
      {/* Window chrome */}
      <div className="flex items-center gap-3 border-b border-white/[0.05] px-4 py-2.5 bg-[#0b0b0e]">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/70" />
        </div>
        <span className="font-mono text-[11px] text-white/30">
          session · 0:30 · alex@acme.dev
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={startFix}
            disabled={fixPhase !== "idle"}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              fixPhase === "idle"
                ? "bg-inari-accent/20 text-inari-accent hover:bg-inari-accent/30"
                : "bg-white/[0.05] text-white/40 cursor-default"
            }`}
          >
            <GitPullRequest className="h-3 w-3" />
            {fixPhase === "done" ? "PR #4821 opened" : fixPhase === "running" ? "Generating…" : "Generate Fix"}
          </button>
        </div>
      </div>

      {/* Badges row */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.05] px-4 py-2.5">
        {errorVisible && (
          <span className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400" style={{ animation: "card-in 0.2s ease both" }}>
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {errorCount} error
          </span>
        )}
        {lcpVisible && (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400" style={{ animation: "card-in 0.2s ease both" }}>
            <Gauge className="h-3 w-3" /> LCP slow
          </span>
        )}
        {(rageVisible || deadVisible) && (
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400" style={{ animation: "card-in 0.2s ease both" }}>
            <MousePointerClick className="h-3 w-3" />
            {rageCount > 0 && <span>{rageCount} rage</span>}
            {rageCount > 0 && deadCount > 0 && <span>·</span>}
            {deadCount > 0 && <span>{deadCount} dead</span>}
          </span>
        )}
        {aiVisible && (
          <span className="inline-flex items-center gap-1 rounded-md bg-inari-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-inari-accent" style={{ animation: "card-in 0.2s ease both" }}>
            <Sparkles className="h-3 w-3" /> AI summary
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-white/30">Chrome · macOS</span>
      </div>

      {/* Main */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px]">
        {/* Stage + timeline */}
        <div className="border-b lg:border-b-0 lg:border-r border-white/[0.05] relative">
          <MockStage time={time} />

          {/* Fix overlay */}
          {fixPhase !== "idle" && (
            <div className="absolute inset-0 bg-[#0a0a0c]/85 backdrop-blur-sm flex items-center justify-center p-6" style={{ animation: "card-in 0.2s ease both" }}>
              <div className="max-w-sm w-full space-y-2">
                <p className="text-[10px] font-mono uppercase tracking-widest text-inari-accent mb-3">
                  Generate Fix · pipeline
                </p>
                {FIX_STEPS.slice(0, fixStep).map((step, i) => (
                  <div key={i} className="flex items-center gap-2" style={{ animation: "card-in 0.25s ease both" }}>
                    <span className="text-[11px] text-emerald-400">✓</span>
                    <span className="text-[11px] text-white/55">{step}</span>
                  </div>
                ))}
                {fixPhase === "running" && fixStep < FIX_STEPS.length && (
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-inari-accent animate-pulse" />
                    <span className="text-[11px] text-inari-accent">{FIX_STEPS[fixStep]}</span>
                  </div>
                )}
                {fixPhase === "done" && (
                  <div className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3" style={{ animation: "card-in 0.3s ease both" }}>
                    <p className="text-[11px] text-emerald-400 font-medium mb-1">PR #4821 — Guard order.total before render</p>
                    <p className="text-[10px] text-white/40 leading-relaxed">
                      11 safety gates passed · auto-merge eligible · watching for regressions (10 min)
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Controls + scrub */}
          <div className="border-t border-white/[0.05] px-4 py-3 bg-[#0b0b0e]">
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
                className="h-7 w-7 rounded-full bg-inari-accent/20 hover:bg-inari-accent/30 text-inari-accent flex items-center justify-center transition-colors"
              >
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
              </button>
              <button
                onClick={reset}
                aria-label="Restart"
                className="h-7 w-7 rounded-full bg-white/[0.05] hover:bg-white/[0.08] text-white/55 flex items-center justify-center transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>

              {/* Scrub bar */}
              <div className="flex-1 relative h-2 rounded-full bg-white/[0.05] cursor-pointer"
                   onClick={(e) => {
                     const rect = e.currentTarget.getBoundingClientRect();
                     const pct = (e.clientX - rect.left) / rect.width;
                     setTime(Math.max(0, Math.min(DURATION, pct * DURATION)));
                   }}
              >
                <div className="absolute inset-y-0 left-0 rounded-full bg-inari-accent/40" style={{ width: `${progress}%` }} />
                <div className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-inari-accent border-2 border-[#0b0b0e]" style={{ left: `calc(${progress}% - 6px)` }} />
                {/* Event ticks */}
                {EVENTS.filter((e) => e.kind === "error" || e.kind === "rage" || e.kind === "dead" || e.kind === "vital").map((e, i) => (
                  <span
                    key={i}
                    className={`absolute top-1/2 -translate-y-1/2 h-2 w-0.5 ${
                      e.kind === "error" ? "bg-red-500" :
                      e.kind === "vital" ? "bg-amber-500" :
                      "bg-red-400/60"
                    }`}
                    style={{ left: `${(e.t / DURATION) * 100}%` }}
                  />
                ))}
              </div>

              <span className="font-mono text-[11px] text-white/45 tabular-nums">
                {fmtTime(time)} / {fmtTime(DURATION)}
              </span>
              <button
                onClick={() => setSpeed((s) => (s === 1 ? 2 : 1))}
                className="font-mono text-[11px] text-white/45 hover:text-white/70 bg-white/[0.04] hover:bg-white/[0.07] rounded px-1.5 py-0.5 transition-colors"
                aria-label="Toggle speed"
              >
                {speed}×
              </button>
            </div>
          </div>
        </div>

        {/* Side panel */}
        <div className="flex flex-col">
          <div className="flex items-center gap-1 border-b border-white/[0.05] px-3 pt-2.5">
            {(["console", "network", "nav"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-[11px] px-2 pb-2 -mb-px border-b-2 transition-colors ${
                  tab === t
                    ? "text-inari-accent border-inari-accent"
                    : "text-white/40 border-transparent hover:text-white/65"
                }`}
              >
                {t === "console" ? "Console" : t === "network" ? "Network" : "Nav"}
              </button>
            ))}
            <span className="ml-auto text-[10px] font-mono text-white/25">
              {tab === "console" && `${eventsBefore(time).filter((e) => e.kind === "console" || e.kind === "click" || e.kind === "error").length}`}
              {tab === "network" && `${eventsBefore(time, "network").length}`}
              {tab === "nav" && `${eventsBefore(time, "nav").length}`}
            </span>
          </div>

          <div className="flex-1 px-4 py-3 overflow-hidden" style={{ minHeight: 220 }}>
            {tab === "console" && <ConsolePanel time={time} />}
            {tab === "network" && <NetworkPanel time={time} />}
            {tab === "nav"     && <NavPanel time={time} />}
          </div>

          {aiVisible && (
            <div className="border-t border-white/[0.05] m-3 mt-0 rounded-md border border-inari-accent/25 bg-inari-accent/[0.06] p-2.5" style={{ animation: "card-in 0.3s ease both" }}>
              <p className="text-[9px] font-mono uppercase tracking-wider text-inari-accent mb-1">AI summary</p>
              <p className="text-[11px] text-white/60 leading-relaxed">
                User reached checkout, hit a slow LCP, then rage-clicked Pay Now after a TypeError fired in the order total handler.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
