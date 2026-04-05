"use client";

import { useState } from "react";
import Image from "next/image";

export function DemoVideo() {
  const [playing, setPlaying] = useState(false);

  return (
    <section className="py-12 bg-inari-bg">
      <div className="mx-auto max-w-4xl px-6">
        <div className="relative rounded-2xl border border-inari-accent/20 overflow-hidden shadow-2xl shadow-purple-500/10">
          {playing ? (
            <video
              autoPlay
              loop
              muted
              playsInline
              className="w-full"
            >
              <source src="/demo.mp4" type="video/mp4" />
            </video>
          ) : (
            <button
              onClick={() => setPlaying(true)}
              className="relative w-full cursor-pointer group"
            >
              <Image
                src="/demo-poster.png"
                alt="InariWatch demo — from error to merged PR in 2 minutes"
                width={1920}
                height={1080}
                className="w-full"
                priority={false}
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                <div className="h-16 w-16 rounded-full bg-white/90 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                  <svg viewBox="0 0 24 24" className="h-7 w-7 text-zinc-900 ml-1" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            </button>
          )}
        </div>
        <p className="text-center text-xs text-zinc-600 mt-3">
          From error to merged PR in 2 minutes. Fully automated.
        </p>
      </div>
    </section>
  );
}
