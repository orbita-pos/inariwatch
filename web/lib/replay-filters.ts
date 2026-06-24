/**
 * Pure filter parsing / normalization for the /replays list page.
 *
 * Keeping this separate from the page component (which mixes in auth +
 * DB) lets us unit-test the tricky parts (URL → filter struct, time
 * windows, pagination bounds) with no fixtures.
 */

export type TimeWindow = "24h" | "7d" | "30d" | "all";
export type SortBy = "createdAt" | "durationMs" | "totalBytes";
export type SortDir = "asc" | "desc";

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
  /** Filter to sessions whose error_fingerprints[] contains this exact value. */
  fingerprint: string;
  /** ILIKE substring against urls_visited (after array_to_string). */
  urlPath: string;
  /** Absolute lower bound on `started_at`. Wins over `since` if both set. */
  dateFrom: Date | null;
  /** Absolute upper bound (inclusive) on `started_at`. Wins over `since`. */
  dateTo: Date | null;
  /** Result ordering column. */
  sortBy: SortBy;
  /** Ascending vs descending. */
  sortDir: SortDir;
  /** Show only sessions with at least one rage-click run (Phase E). */
  hasRageClicks: boolean;
  /** Show only sessions with at least one dead click (Phase E). */
  hasDeadClicks: boolean;
  /** Phase F — exact-match end-user id (drives "show all sessions for X"). */
  endUserId: string;
  /** Phase F — substring search against end-user email. */
  endUserEmail: string;
}

export const PAGE_SIZE = 50;
const MAX_PAGE = 1000; // hard cap — prevents accidental DoS via huge OFFSETs
const MAX_Q_LENGTH = 200;
const MAX_BROWSER_LENGTH = 50;
const MAX_FINGERPRINT_LENGTH = 100;
const MAX_URL_PATH_LENGTH = 500;
const DEFAULT_WINDOW: TimeWindow = "7d";
const DEFAULT_SORT_BY: SortBy = "createdAt";
const DEFAULT_SORT_DIR: SortDir = "desc";

const VALID_WINDOWS: readonly TimeWindow[] = ["24h", "7d", "30d", "all"];
const VALID_SORT_BY: readonly SortBy[] = ["createdAt", "durationMs", "totalBytes"];
const VALID_SORT_DIR: readonly SortDir[] = ["asc", "desc"];

function firstString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Parse `YYYY-MM-DD` (or any value Date can swallow) into a Date. Returns
 * null for empty / invalid inputs so the caller can skip the WHERE branch
 * cleanly. We intentionally do NOT clamp ranges here — that's the SQL's job.
 */
function parseDateParam(raw: string, endOfDay: boolean): Date | null {
  if (!raw) return null;
  // `new Date("2026-04-14")` parses as UTC midnight which is what we want.
  // For dateTo we bump to end-of-day so the range is inclusive on the day.
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  if (endOfDay) {
    // Push to 23:59:59.999 UTC of the same calendar day so a `to=2026-04-14`
    // covers everything that happened that day.
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
  }
  return d;
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

  const fingerprint = firstString(raw.fingerprint).trim().slice(0, MAX_FINGERPRINT_LENGTH);
  const urlPath = firstString(raw.urlPath).trim().slice(0, MAX_URL_PATH_LENGTH);

  const dateFrom = parseDateParam(firstString(raw.dateFrom).trim(), false);
  const dateTo = parseDateParam(firstString(raw.dateTo).trim(), true);

  const sortByRaw = firstString(raw.sortBy) as SortBy;
  const sortBy = VALID_SORT_BY.includes(sortByRaw) ? sortByRaw : DEFAULT_SORT_BY;

  const sortDirRaw = firstString(raw.sortDir).toLowerCase() as SortDir;
  const sortDir = VALID_SORT_DIR.includes(sortDirRaw) ? sortDirRaw : DEFAULT_SORT_DIR;

  const hasRageClicks = firstString(raw.hasRageClicks).toLowerCase() === "true" || firstString(raw.hasRageClicks) === "1";
  const hasDeadClicks = firstString(raw.hasDeadClicks).toLowerCase() === "true" || firstString(raw.hasDeadClicks) === "1";

  const endUserId = firstString(raw.endUserId).trim().slice(0, 200);
  const endUserEmail = firstString(raw.endUserEmail).trim().slice(0, 200);

  return {
    q, errorsOnly, browser, since, page,
    fingerprint, urlPath, dateFrom, dateTo, sortBy, sortDir,
    hasRageClicks, hasDeadClicks,
    endUserId, endUserEmail,
  };
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

/** Check whether any filter other than the defaults is active. */
export function hasActiveFilters(f: ReplayFilters): boolean {
  return (
    f.q.length > 0 ||
    f.errorsOnly ||
    f.browser.length > 0 ||
    f.since !== DEFAULT_WINDOW ||
    f.fingerprint.length > 0 ||
    f.urlPath.length > 0 ||
    f.dateFrom !== null ||
    f.dateTo !== null ||
    f.sortBy !== DEFAULT_SORT_BY ||
    f.sortDir !== DEFAULT_SORT_DIR ||
    f.hasRageClicks ||
    f.hasDeadClicks ||
    f.endUserId.length > 0 ||
    f.endUserEmail.length > 0
  );
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
 * Format a Date as `YYYY-MM-DD` for the UI date inputs and the URL. We
 * use UTC date components so the value the user sees / shares matches
 * what the server filtered on, regardless of viewer's timezone.
 */
export function dateToInputValue(d: Date | null | undefined): string {
  if (!d) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  if (f.fingerprint && f.fingerprint.length > 0) params.set("fingerprint", f.fingerprint);
  if (f.urlPath && f.urlPath.length > 0) params.set("urlPath", f.urlPath);
  if (f.dateFrom) params.set("dateFrom", dateToInputValue(f.dateFrom));
  if (f.dateTo) params.set("dateTo", dateToInputValue(f.dateTo));
  if (f.sortBy && f.sortBy !== DEFAULT_SORT_BY) params.set("sortBy", f.sortBy);
  if (f.sortDir && f.sortDir !== DEFAULT_SORT_DIR) params.set("sortDir", f.sortDir);
  if (f.hasRageClicks) params.set("hasRageClicks", "true");
  if (f.hasDeadClicks) params.set("hasDeadClicks", "true");
  if (f.endUserId && f.endUserId.length > 0) params.set("endUserId", f.endUserId);
  if (f.endUserEmail && f.endUserEmail.length > 0) params.set("endUserEmail", f.endUserEmail);
  return params.toString();
}
