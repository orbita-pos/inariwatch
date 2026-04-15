/**
 * Pure filter parsing / normalization for the /replays list page.
 *
 * Keeping this separate from the page component (which mixes in auth +
 * DB) lets us unit-test the tricky parts (URL → filter struct, time
 * windows, pagination bounds) with no fixtures.
 */

export type TimeWindow = "24h" | "7d" | "30d" | "all";

export interface ReplayFilters {
  /** Free-text query — matched against click_selectors and urls_visited via ILIKE. */
  q: string;
  /** True to show only sessions that captured at least one error event. */
  errorsOnly: boolean;
  /** Exact browser name substring (e.g. "Chrome"). Empty string = any. */
  browser: string;
  /** Rolling time window from now. */
  since: TimeWindow;
  /** 1-indexed page number, minimum 1. */
  page: number;
}

export const PAGE_SIZE = 50;
const MAX_PAGE = 1000; // hard cap — prevents accidental DoS via huge OFFSETs
const MAX_Q_LENGTH = 200;
const MAX_BROWSER_LENGTH = 50;
const DEFAULT_WINDOW: TimeWindow = "7d";

const VALID_WINDOWS: readonly TimeWindow[] = ["24h", "7d", "30d", "all"];

function firstString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Convert Next.js `searchParams` (the Promise-resolved form) into a
 * validated filter struct. Unknown keys are ignored; invalid values fall
 * back to sensible defaults.
 */
export function parseReplayFilters(
  raw: Record<string, string | string[] | undefined>,
): ReplayFilters {
  const q = firstString(raw.q).trim().slice(0, MAX_Q_LENGTH);
  const errorsOnly = firstString(raw.errors).toLowerCase() === "true" || firstString(raw.errors) === "1";

  const browserRaw = firstString(raw.browser).trim().slice(0, MAX_BROWSER_LENGTH);
  const browser = browserRaw;

  const sinceRaw = firstString(raw.since).toLowerCase() as TimeWindow;
  const since = VALID_WINDOWS.includes(sinceRaw) ? sinceRaw : DEFAULT_WINDOW;

  const pageRaw = parseInt(firstString(raw.page), 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.min(MAX_PAGE, pageRaw)) : 1;

  return { q, errorsOnly, browser, since, page };
}

/**
 * Convert a time window to a concrete lower bound. "all" returns null,
 * meaning no date filter at all.
 */
export function sinceToDate(since: TimeWindow, now: Date = new Date()): Date | null {
  switch (since) {
    case "24h": return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "7d":  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d": return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all": return null;
  }
}

/** Check whether any filter other than the default time window is active. */
export function hasActiveFilters(f: ReplayFilters): boolean {
  return f.q.length > 0 || f.errorsOnly || f.browser.length > 0 || f.since !== DEFAULT_WINDOW;
}

/**
 * Build a safe `%pattern%` for ILIKE. Escapes the three LIKE metacharacters
 * (%, _, \) so user input can't match unintended rows. Already lowercase —
 * caller should pass ILIKE.
 */
export function toLikePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Pagination math shared by the server page + any client renderers. */
export function paginationInfo(page: number, totalCount: number): {
  page: number;
  totalPages: number;
  offset: number;
  limit: number;
} {
  const safePage = Math.max(1, Math.min(MAX_PAGE, page));
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  return {
    page: safePage,
    totalPages,
    offset: (safePage - 1) * PAGE_SIZE,
    limit: PAGE_SIZE,
  };
}

/**
 * Rebuild a URL querystring from a filter struct. Used by the client
 * filter component to keep filters reflected in the address bar.
 */
export function filtersToSearchString(f: Partial<ReplayFilters>): string {
  const params = new URLSearchParams();
  if (f.q && f.q.length > 0) params.set("q", f.q);
  if (f.errorsOnly) params.set("errors", "true");
  if (f.browser && f.browser.length > 0) params.set("browser", f.browser);
  if (f.since && f.since !== DEFAULT_WINDOW) params.set("since", f.since);
  if (f.page && f.page > 1) params.set("page", String(f.page));
  return params.toString();
}
