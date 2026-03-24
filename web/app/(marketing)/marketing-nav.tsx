"use client";

import Link from "next/link";
import Image from "next/image";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export function MarketingNav({ opaque = false }: { opaque?: boolean }) {
  const [scrolled, setScrolled] = useState(opaque);

  useEffect(() => {
    if (opaque) return;
    const handler = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, [opaque]);

  return (
    <nav
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-inari-border bg-inari-bg/90 backdrop-blur-md"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/logo-inari/favicon-96x96.png"
            alt="InariWatch"
            width={36}
            height={36}
            className="shrink-0"
          />
          <span className={`font-mono font-bold uppercase tracking-widest text-sm transition-colors ${scrolled ? "text-fg-strong" : "text-white"}`}>
            INARIWATCH
          </span>
        </Link>

        <div className={`hidden items-center gap-6 text-sm md:flex transition-colors ${scrolled ? "text-fg-base" : "text-white/80"}`}>
          <Link href="/#integrations" className={`transition-colors ${scrolled ? "hover:text-fg-strong" : "hover:text-white"}`}>Integrations</Link>
          <Link href="/#ai"          className={`transition-colors ${scrolled ? "hover:text-fg-strong" : "hover:text-white"}`}>AI features</Link>
          <Link href="/docs"         className={`transition-colors ${scrolled ? "hover:text-fg-strong" : "hover:text-white"}`}>Docs</Link>
          <Link href="/blog"         className={`transition-colors ${scrolled ? "hover:text-fg-strong" : "hover:text-white"}`}>Blog</Link>
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link href="/login">
            <Button
              variant="outline"
              size="sm"
              className={scrolled ? "" : "border-white/30 text-white hover:bg-white/10 hover:border-white/50 bg-white/5"}
            >
              Sign in
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}
