"use client";

import { useState } from "react";
import Image from "next/image";

export function DemoVideo() {
  const [playing, setPlaying] = useState(false);

  return (
    <section className="py-12 bg-inari-bg">
      <div className="mx-auto max-w-4xl px-6">
        <div className="relative rounded-2xl border border-inari-accent/20 overflow-hidden shadow-lg dark:shadow-2xl shadow-inari-accent/10">
          {playing ? (
            <video
              autoPlay
              loop
              muted
              playsInline
              aria-label="InariWatch product demo — autonomous remediation from error to merged PR"
              className="w-full"
            >
              <source src="/demo.mp4" type="video/mp4" />
            </video>
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              aria-label="Play InariWatch product demo"
              className="relative w-full cursor-pointer group"
            >
              <Image
                src="/demo-poster.png"
                alt="InariWatch demo — autonomous remediation preview"
                width={1920}
                height={1080}
                className="w-full"
                priority={false}
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                <div className="h-16 w-16 rounded-full bg-fg-strong flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                  <svg viewBox="0 0 24 24" className="h-7 w-7 text-inari-bg ml-1" fill="currentColor" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            </button>
          )}
        </div>
        <p className="text-center text-xs text-fg-base mt-3">
          Autonomous remediation — from error to merged PR.
        </p>
      </div>
    </section>
  );
}
