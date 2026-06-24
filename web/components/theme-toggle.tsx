"use client";

import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { useEffect, useState } from "react";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button
        className={`flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 ${className}`}
        aria-label="Toggle theme"
      >
        <Sun className="h-3.5 w-3.5" />
      </button>
    );
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.06] hover:text-fg-strong ${className}`}
      aria-label="Toggle theme"
    >
      {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </button>
  );
}
