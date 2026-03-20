"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, X, LogOut } from "lucide-react";
import { NAV_ITEMS } from "./nav";
import { ThemeToggle } from "@/components/theme-toggle";

interface MobileNavProps {
  unreadAlerts: number;
  userInitial: string;
  userName: string;
  userEmail?: string;
}

export function MobileNav({ unreadAlerts, userInitial, userName, userEmail }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      {/* Top bar — visible only on mobile */}
      <div className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between border-b border-line bg-surface px-4 md:hidden">
        {/* Left: hamburger */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-400 hover:text-fg-strong hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Center: logo */}
        <Link href="/" className="flex items-center gap-2">
          <Image
            src="/logo-inari/favicon-96x96.png"
            alt="InariWatch"
            width={32}
            height={32}
            className="shrink-0"
          />
          <span className="font-mono text-sm font-semibold uppercase tracking-[0.15em] text-fg-strong">
            InariWatch
          </span>
        </Link>

        {/* Right: theme toggle + user avatar */}
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Link
            href="/settings"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-inari-accent text-[11px] font-bold text-white"
          >
            {userInitial}
          </Link>
        </div>
      </div>

      {/* Overlay */}
      <div
        className={`fixed inset-0 z-50 bg-black/70 transition-opacity duration-300 md:hidden ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={close}
        aria-hidden="true"
      />

      {/* Slide-in drawer */}
      <div
        className={`fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-line bg-surface transition-transform duration-300 ease-in-out md:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Drawer header */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
          <Link href="/" className="flex items-center gap-2.5" onClick={close}>
            <Image
              src="/logo-inari/favicon-96x96.png"
              alt="InariWatch"
              width={28}
              height={28}
              className="shrink-0"
            />
            <span className="font-mono text-sm font-semibold uppercase tracking-[0.15em] text-fg-strong">
              InariWatch
            </span>
          </Link>
          <button
            type="button"
            onClick={close}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-fg-strong hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav links */}
        <nav className="flex-1 px-2 py-3 space-y-px overflow-y-auto">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + "/");
            const showBadge = href === "/alerts" && unreadAlerts > 0;
            return (
              <Link
                key={href}
                href={href}
                onClick={close}
                className={`relative flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-all ${
                  active
                    ? "bg-black/[0.06] dark:bg-white/[0.06] text-fg-strong"
                    : "text-zinc-500 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] hover:text-fg-base"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-inari-accent" />
                )}
                <Icon className={`h-4 w-4 shrink-0 ${active ? "text-inari-accent" : "text-zinc-600"}`} />
                <span className={active ? "font-medium" : ""}>{label}</span>
                {showBadge && (
                  <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-inari-accent px-1.5 text-[10px] font-bold text-white">
                    {unreadAlerts > 99 ? "99+" : unreadAlerts}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* User section at bottom */}
        <div className="shrink-0 border-t border-line p-3">
          <div className="flex items-center gap-2.5 rounded-md px-2 py-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-inari-accent text-[11px] font-bold text-white">
              {userInitial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg-base">
                {userName}
              </p>
              {userEmail && userName !== userEmail && (
                <p className="truncate text-xs text-zinc-500">{userEmail}</p>
              )}
              <p className="text-xs text-inari-accent">100% Free</p>
            </div>
            <Link
              href="/api/auth/signout"
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-400 transition-colors"
              title="Sign out"
              onClick={close}
            >
              <LogOut className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
