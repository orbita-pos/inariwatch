"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const SINCE_OPTIONS: { value: string; label: string }[] = [
  { value: "24h", label: "Last 24 h" },
  { value: "7d",  label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

interface Props {
  q: string;
  errorsOnly: boolean;
  browser: string;
  since: string;
  browserOptions: string[];
}

export function ReplaysFilters({ q, errorsOnly, browser, since, browserOptions }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [localQ, setLocalQ] = useState(q);

  // Sync local state when the URL changes from outside (back/forward nav)
  useEffect(() => { setLocalQ(q); }, [q]);

  const navigate = useCallback((next: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v.length === 0) params.delete(k);
      else params.set(k, v);
    }
    // Filter changes reset to page 1
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }, [router, pathname, searchParams]);

  // Debounce search input → URL
  useEffect(() => {
    if (localQ === q) return;
    const t = setTimeout(() => navigate({ q: localQ || null }), 300);
    return () => clearTimeout(t);
  }, [localQ, q, navigate]);

  return (
    <div className="space-y-3">
      <input
        type="search"
        inputMode="search"
        placeholder="Search by clicked selector or URL (e.g. 'button.submit', '/checkout')"
        value={localQ}
        onChange={(e) => setLocalQ(e.target.value)}
        className="w-full rounded-lg border border-line bg-surface px-4 py-2 text-sm text-fg-base placeholder:text-fg-base/40 focus:outline-none focus:border-inari-accent"
      />

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={since}
          onChange={(e) => navigate({ since: e.target.value === "7d" ? null : e.target.value })}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-base focus:outline-none focus:border-inari-accent"
          aria-label="Time window"
        >
          {SINCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={browser}
          onChange={(e) => navigate({ browser: e.target.value || null })}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-base focus:outline-none focus:border-inari-accent"
          aria-label="Browser"
        >
          <option value="">Any browser</option>
          {browserOptions.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => navigate({ errors: errorsOnly ? null : "true" })}
          aria-pressed={errorsOnly}
          className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            errorsOnly
              ? "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400"
              : "border-line text-fg-base/70 hover:text-fg-base"
          }`}
        >
          {errorsOnly ? "🔴 Errors only" : "Errors only"}
        </button>
      </div>
    </div>
  );
}
