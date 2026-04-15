"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { dateToInputValue, type SortBy, type SortDir, type TimeWindow } from "@/lib/replay-filters";

const SINCE_OPTIONS: { value: TimeWindow; label: string }[] = [
  { value: "24h", label: "Last 24 h" },
  { value: "7d",  label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "createdAt",  label: "Date" },
  { value: "durationMs", label: "Duration" },
  { value: "totalBytes", label: "Size" },
];

interface Props {
  q: string;
  errorsOnly: boolean;
  browser: string;
  since: TimeWindow;
  fingerprint: string;
  urlPath: string;
  dateFrom: Date | null;
  dateTo: Date | null;
  sortBy: SortBy;
  sortDir: SortDir;
  hasRageClicks: boolean;
  hasDeadClicks: boolean;
  endUserId: string;
  endUserEmail: string;
  browserOptions: string[];
}

interface FilterOptions {
  fingerprints: string[];
  urlPaths: string[];
}

export function ReplaysFilters({
  q,
  errorsOnly,
  browser,
  since,
  fingerprint,
  urlPath,
  dateFrom,
  dateTo,
  sortBy,
  sortDir,
  hasRageClicks,
  hasDeadClicks,
  endUserId,
  endUserEmail,
  browserOptions,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [localQ, setLocalQ] = useState(q);
  const [localUrlPath, setLocalUrlPath] = useState(urlPath);
  const [localEndUserEmail, setLocalEndUserEmail] = useState(endUserEmail);
  const [options, setOptions] = useState<FilterOptions>({ fingerprints: [], urlPaths: [] });

  // Sync local inputs when URL changes from outside (back/forward nav)
  useEffect(() => { setLocalQ(q); }, [q]);
  useEffect(() => { setLocalUrlPath(urlPath); }, [urlPath]);
  useEffect(() => { setLocalEndUserEmail(endUserEmail); }, [endUserEmail]);

  // Lazy-load filter options on mount. Cached server-side for 60s so this
  // is a single Redis lookup most of the time. Failures are silent —
  // dropdowns just stay empty.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/replay/filter-options")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: FilterOptions | null) => {
        if (!cancelled && data) setOptions(data);
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, []);

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

  // Same debounce for URL-path filter (autocompleted via <datalist>)
  useEffect(() => {
    if (localUrlPath === urlPath) return;
    const t = setTimeout(() => navigate({ urlPath: localUrlPath || null }), 300);
    return () => clearTimeout(t);
  }, [localUrlPath, urlPath, navigate]);

  // Phase F — debounced end-user email filter
  useEffect(() => {
    if (localEndUserEmail === endUserEmail) return;
    const t = setTimeout(() => navigate({ endUserEmail: localEndUserEmail || null }), 300);
    return () => clearTimeout(t);
  }, [localEndUserEmail, endUserEmail, navigate]);

  // Switching to an absolute date range clears the rolling `since` from the URL
  // because the page WHERE clause prefers absolute over rolling. Keeping
  // both in the URL would be misleading.
  const setDate = useCallback((key: "dateFrom" | "dateTo", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
      params.delete("since"); // absolute wins → rolling becomes irrelevant
    } else {
      params.delete(key);
    }
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }, [router, pathname, searchParams]);

  return (
    <div className="space-y-3">
      {/* Sticky end-user filter pill — only shows when an exact-match endUserId
          is active. Lets the reviewer clear it without hunting for the field. */}
      {endUserId && (
        <div className="flex items-center gap-2 rounded-lg border border-inari-accent/40 bg-inari-accent/5 px-3 py-1.5 text-xs">
          <span className="text-fg-base/60">Showing only sessions for user</span>
          <span className="font-mono font-medium text-inari-accent">{endUserId}</span>
          <button
            type="button"
            onClick={() => navigate({ endUserId: null })}
            className="ml-auto text-fg-base/60 hover:text-fg-base"
            aria-label="Clear end-user filter"
          >
            ✕
          </button>
        </div>
      )}

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
          disabled={dateFrom !== null || dateTo !== null}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-base focus:outline-none focus:border-inari-accent disabled:opacity-40"
          aria-label="Time window"
          title={dateFrom || dateTo ? "Disabled while a custom date range is set" : undefined}
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

        <select
          value={fingerprint}
          onChange={(e) => navigate({ fingerprint: e.target.value || null })}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-base focus:outline-none focus:border-inari-accent"
          aria-label="Error fingerprint"
        >
          <option value="">Any error</option>
          {options.fingerprints.map((fp) => (
            <option key={fp} value={fp}>{fp.slice(0, 24)}{fp.length > 24 ? "…" : ""}</option>
          ))}
        </select>

        <input
          type="text"
          list="iw-replay-urlpath-options"
          placeholder="URL contains…"
          value={localUrlPath}
          onChange={(e) => setLocalUrlPath(e.target.value)}
          className="w-44 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-base placeholder:text-fg-base/40 focus:outline-none focus:border-inari-accent"
          aria-label="URL path"
        />

        <input
          type="text"
          placeholder="user email (exact)…"
          value={localEndUserEmail}
          onChange={(e) => setLocalEndUserEmail(e.target.value)}
          title="Exact match — substring search would expose hashed addresses"
          className="w-48 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-base placeholder:text-fg-base/40 focus:outline-none focus:border-inari-accent"
          aria-label="End-user email"
        />
        <datalist id="iw-replay-urlpath-options">
          {options.urlPaths.map((u) => (<option key={u} value={u} />))}
        </datalist>

        <input
          type="date"
          value={dateToInputValue(dateFrom)}
          onChange={(e) => setDate("dateFrom", e.target.value)}
          className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-fg-base focus:outline-none focus:border-inari-accent"
          aria-label="From date"
        />
        <span className="text-xs text-fg-base/50">→</span>
        <input
          type="date"
          value={dateToInputValue(dateTo)}
          onChange={(e) => setDate("dateTo", e.target.value)}
          className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-fg-base focus:outline-none focus:border-inari-accent"
          aria-label="To date"
        />

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

        <button
          type="button"
          onClick={() => navigate({ hasRageClicks: hasRageClicks ? null : "true" })}
          aria-pressed={hasRageClicks}
          className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            hasRageClicks
              ? "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "border-line text-fg-base/70 hover:text-fg-base"
          }`}
          title="Sessions with at least one rage-click run"
        >
          Rage
        </button>

        <button
          type="button"
          onClick={() => navigate({ hasDeadClicks: hasDeadClicks ? null : "true" })}
          aria-pressed={hasDeadClicks}
          className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            hasDeadClicks
              ? "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "border-line text-fg-base/70 hover:text-fg-base"
          }`}
          title="Sessions with at least one dead click"
        >
          Dead
        </button>

        <div className="ml-auto flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-fg-base/40">Sort</span>
          <select
            value={sortBy}
            onChange={(e) => navigate({ sortBy: e.target.value === "createdAt" ? null : e.target.value })}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-fg-base focus:outline-none focus:border-inari-accent"
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => navigate({ sortDir: sortDir === "asc" ? null : "asc" })}
            aria-label={`Sort direction: ${sortDir === "asc" ? "ascending" : "descending"}`}
            title={sortDir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-fg-base/70 hover:text-fg-base focus:outline-none focus:border-inari-accent"
          >
            {sortDir === "asc" ? "↑" : "↓"}
          </button>
        </div>
      </div>
    </div>
  );
}
