"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// ── Storage ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = "inariwatch-cookie-consent";
const STORAGE_VER = "1"; // bump to re-prompt after policy changes

type ConsentValue = "all" | "essential";

interface StoredConsent {
  value: ConsentValue;
  version: string;
  ts: number;
}

function readConsent(): StoredConsent | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConsent;
    if (parsed.version !== STORAGE_VER) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeConsent(value: ConsentValue) {
  const payload: StoredConsent = { value, version: STORAGE_VER, ts: Date.now() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

// ── Component ─────────────────────────────────────────────────────────────────
export function CookieConsent() {
  // null = checking, false = hidden, true = visible
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const consent = readConsent();
    if (!consent) {
      // Small delay so the page paints first — avoids CLS on first load
      const id = setTimeout(() => {
        setVisible(true);
        setMounted(true);
      }, 600);
      return () => clearTimeout(id);
    }
    setMounted(true);
  }, []);

  function dismiss(value: ConsentValue) {
    writeConsent(value);
    setLeaving(true);
    setTimeout(() => setVisible(false), 300);
  }

  if (!mounted || !visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie preferences"
      aria-live="polite"
      className={`
        fixed bottom-5 inset-x-0 z-[9999] flex justify-center px-4
        transition-all duration-300 ease-out
        ${leaving ? "opacity-0 translate-y-3 pointer-events-none" : "opacity-100 translate-y-0"}
      `}
    >
      <div
        className="
          w-full max-w-[680px]
          rounded-xl border border-[--bd-default]
          bg-[--bg-card]/95 backdrop-blur-md
          shadow-[0_8px_32px_-4px_rgba(0,0,0,0.35)]
          px-5 py-4
        "
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
          {/* Text */}
          <div className="flex-1 min-w-0">
            <p className="text-[13px] leading-relaxed text-[--fg-base]">
              <span className="font-medium text-[--fg-strong]">We use cookies</span>
              {" "}to keep you signed in and understand how InariWatch is used.
              Essential cookies are always on.{" "}
              <Link
                href="/privacy"
                className="underline underline-offset-2 decoration-[--bd-medium] hover:decoration-[--fg-base] transition-colors"
              >
                Privacy Policy
              </Link>
            </p>
          </div>

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => dismiss("essential")}
              className="
                rounded-md border border-[--bd-default] bg-transparent
                px-3.5 py-1.5 text-[13px] font-medium text-[--fg-base]
                hover:bg-[--bg-card-inner] hover:text-[--fg-strong]
                transition-colors focus-visible:outline focus-visible:outline-2
                focus-visible:outline-offset-2 focus-visible:outline-zinc-500
                whitespace-nowrap
              "
            >
              Essential only
            </button>
            <button
              onClick={() => dismiss("all")}
              className="
                rounded-md
                bg-[--fg-strong] text-[--bg-page]
                dark:bg-white dark:text-[#0a0a0c]
                px-3.5 py-1.5 text-[13px] font-medium
                hover:opacity-90
                transition-opacity focus-visible:outline focus-visible:outline-2
                focus-visible:outline-offset-2 focus-visible:outline-zinc-500
                whitespace-nowrap
              "
            >
              Accept all
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
