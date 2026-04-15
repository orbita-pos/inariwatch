"use client";

import Link from "next/link";
import Image from "next/image";

import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

export function MarketingNav({ opaque = false }: { opaque?: boolean }) {
  const [scrolled, setScrolled] = useState(opaque);

  useEffect(() => {
    if (opaque) return;
    const handler = () => setScrolled(window.scrollY > 8);
    handler();
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, [opaque]);

  return (
    <nav
      className={`fixed top-0 inset-x-0 z-50 transition-colors duration-200 ${
        scrolled
          ? "border-b border-inari-border bg-inari-bg/80 backdrop-blur-md"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        {/* Logo — left */}
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/logo-inari/favicon-96x96.png"
            alt="InariWatch"
            width={26}
            height={26}
            className="shrink-0"
          />
          <span className="font-display font-semibold tracking-tight text-[15px] text-fg-strong">
            Inariwatch
          </span>
        </Link>

        {/* Right cluster — nav links + separator + auth */}
        <div className="flex items-center gap-5">
          <div className="hidden items-center gap-6 text-sm md:flex text-fg-base">
            <Link href="/replay" className="inline-flex items-center gap-1.5 hover:text-fg-strong transition-colors">
              Replay
              <span className="rounded-full bg-inari-accent/15 text-inari-accent px-1.5 py-px text-[9px] font-mono uppercase tracking-wider">New</span>
            </Link>
            <Link href="/pricing" className="hover:text-fg-strong transition-colors">
              Pricing
            </Link>
            <Link href="/docs" className="hover:text-fg-strong transition-colors">
              Docs
            </Link>
            <Link href="/trust" className="hover:text-fg-strong transition-colors">
              Trust
            </Link>
            <Link href="/blog" className="hover:text-fg-strong transition-colors">
              Blog
            </Link>
          </div>

          <div className="hidden h-5 w-px bg-inari-border md:block" aria-hidden />

          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/login"
              className="hidden text-sm text-fg-base hover:text-fg-strong transition-colors sm:inline"
            >
              Log in
            </Link>
            <Link
              href="/register"
              className="inline-flex items-center rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors bg-[#0a0a0c] text-white hover:bg-[#1a1a1f] dark:bg-white dark:text-[#0a0a0c] dark:hover:bg-white/90"
            >
              Sign up
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
