"use client";

import Link from "next/link";
import Image from "next/image";
import { Github } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

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
          <span className="font-mono font-bold text-white uppercase tracking-widest text-sm">
            INARIWATCH
          </span>
        </Link>

        <div className="hidden items-center gap-6 text-sm text-white/80 md:flex">
          <Link href="#integrations" className="hover:text-white transition-colors">Integrations</Link>
          <Link href="#ai"           className="hover:text-white transition-colors">AI features</Link>
          <Link href="#pricing"      className="hover:text-white transition-colors">Pricing</Link>
          <Link href="/docs"         className="hover:text-white transition-colors">Docs</Link>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="#"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-sm text-white/80 hover:text-white transition-colors"
          >
            <Github className="h-4 w-4" />
            <span className="hidden sm:inline">GitHub</span>
          </Link>
          <ThemeToggle />
          <Link href="/login">
            <Button
              variant="outline"
              size="sm"
              className="border-white/30 text-white hover:bg-white/10 hover:border-white/50"
            >
              Sign in
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}
