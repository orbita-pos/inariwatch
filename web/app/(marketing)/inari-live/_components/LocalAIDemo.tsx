"use client";

/**
 * Sesión 30 — Section 1: "Tab + Apply that work offline".
 *
 * Currently renders an animated CSS/SVG mockup. The real 60-second
 * screen capture lives at /inari-live/demo-60s.mp4 — recorded in S32
 * once the binary is signed. Until then the <video> source is missing
 * and the poster + animated overlay carry the demo.
 *
 * TODO(S32): drop public/inari-live/demo-60s.mp4 and replace the
 *            animated mockup with the <video> as the primary visual.
 */

const GHOST_SUGGESTION = "  return user?.email?.toLowerCase().trim();";
const APPLY_DIFF_LINES = [
  { kind: "context" as const, text: "function normalizeUser(user: User) {" },
  { kind: "remove" as const, text: "  return user.email;" },
  { kind: "add" as const, text: "  return user?.email?.toLowerCase().trim();" },
  { kind: "context" as const, text: "}" },
];

export function LocalAIDemo() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
        <div>
          <span className="inline-flex items-center rounded-full border border-inari-border bg-inari-card px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
            01 · Local AI
          </span>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg-strong sm:text-4xl">
            Tab + Apply that work offline
          </h2>
          <p className="mt-4 text-base text-fg-base leading-relaxed">
            Qwen2.5-Coder for completions. Kortix FastApply for instant edits.
            Both ship as quantized GGUF and run on your machine via{" "}
            <code className="font-mono text-fg-strong">llama.cpp</code> with
            Metal, CUDA, Vulkan, or pure CPU. Your code never leaves your
            laptop.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-fg-base">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
              Editor-agnostic via LSP — VS Code, Cursor, Zed, Neovim, JetBrains, Helix.
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
              First Tab in &lt;200 ms. First Apply in &lt;800 ms. Both targeted from M-series and modern x86.
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
              0.5B fallback model auto-loads on machines under 8 GB RAM.
            </li>
          </ul>
        </div>

        <div
          data-testid="local-ai-demo"
          className="relative overflow-hidden rounded-xl border border-inari-border bg-[#0a0a0c] shadow-2xl"
        >
          <video
            className="block w-full"
            poster="/inari-live/demo-poster.svg"
            autoPlay
            muted
            loop
            playsInline
            preload="none"
          >
            {/* TODO(S32): drop the real capture at this URL. */}
            <source src="/inari-live/demo-60s.mp4" type="video/mp4" />
          </video>

          {/* Animated CSS mockup — visible until the mp4 lands. Hidden
              if the video loads successfully via the <video> wrapper's
              own paint. Kept in the DOM so the demo never looks empty. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex flex-col gap-4 p-6 font-mono text-[13px] leading-relaxed"
          >
            <div className="flex items-center gap-1.5 text-[11px] text-white/40">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
              <span className="ml-3">user.ts · offline</span>
            </div>
            <div className="space-y-1">
              {APPLY_DIFF_LINES.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.kind === "add"
                      ? "rounded bg-emerald-500/10 px-2 text-emerald-300"
                      : line.kind === "remove"
                        ? "rounded bg-red-500/10 px-2 text-red-300/80 line-through decoration-red-300/50"
                        : "px-2 text-white/70"
                  }
                  style={{
                    animation: `inariFade 6s ease-in-out ${i * 0.2}s infinite`,
                  }}
                >
                  {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
                  {line.text}
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-3 px-2 text-[11px]">
              <span className="rounded border border-white/20 px-1.5 py-0.5 text-white/50">
                Tab
              </span>
              <span className="text-white/40">→</span>
              <span className="text-emerald-300/80">{GHOST_SUGGESTION.trim()}</span>
            </div>
          </div>

          <style>
            {`@keyframes inariFade {
              0%, 20% { opacity: 0; transform: translateY(4px); }
              30%, 80% { opacity: 1; transform: translateY(0); }
              100% { opacity: 0; transform: translateY(-4px); }
            }`}
          </style>
        </div>
      </div>
    </section>
  );
}
