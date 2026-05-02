"use client";

/**
 * Sesión 30 — Hero for /inari-live.
 *
 * The headline + subheadline copy is LOCKED — see INARI_LIVE_DECISIONS.md
 * 2026-05-01 § Sesión 30 (hero copy locked). Tests assert these strings
 * verbatim; do not paraphrase them when redesigning.
 */

import { DownloadButtons } from "./DownloadButtons";

export const HERO_HEADLINE = "Local by default. Cloud by choice. Provable always.";
export const HERO_SUBHEADLINE =
  "The first AI dev companion that runs entirely on your machine, signs every change cryptographically, and works in any editor.";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="absolute inset-x-0 top-0 h-[640px] pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 30% 0%, rgba(249,115,22,0.14) 0%, transparent 70%)",
        }}
        aria-hidden
      />
      <div
        className="absolute inset-0 pointer-events-none bg-grid"
        style={{
          maskImage:
            "radial-gradient(ellipse 80% 55% at 30% 0%, black 0%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 55% at 30% 0%, black 0%, transparent 100%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-5xl px-6 pt-32 pb-16 sm:pt-40 sm:pb-20 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-3 py-1">
          <span className="h-1.5 w-1.5 rounded-full bg-inari-accent animate-pulse" />
          <span className="text-[11px] font-mono uppercase tracking-wider text-inari-accent">
            Inari Live · v0.2 beta
          </span>
        </div>

        <h1
          data-testid="hero-headline"
          className="mx-auto max-w-4xl text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg-strong sm:text-[56px] lg:text-[64px]"
        >
          {HERO_HEADLINE}
        </h1>

        <p
          data-testid="hero-subheadline"
          className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-fg-base"
        >
          {HERO_SUBHEADLINE}
        </p>

        <div className="mt-10 flex justify-center">
          <DownloadButtons variant="row" />
        </div>

        <p className="mt-4 text-xs text-fg-muted">
          No cloud round-trip. No telemetry. No editor lock-in.
        </p>
      </div>
    </section>
  );
}
