import { describe, it, expect } from "vitest";
import {
  parseReplayFilters,
  sinceToDate,
  hasActiveFilters,
  toLikePattern,
  paginationInfo,
  filtersToSearchString,
  dateToInputValue,
  PAGE_SIZE,
  type ReplayFilters,
} from "../replay-filters";

const DEFAULTS: ReplayFilters = {
  q: "",
  errorsOnly: false,
  browser: "",
  since: "7d",
  page: 1,
  fingerprint: "",
  urlPath: "",
  dateFrom: null,
  dateTo: null,
  sortBy: "createdAt",
  sortDir: "desc",
  hasRageClicks: false,
  hasDeadClicks: false,
  endUserId: "",
  endUserEmail: "",
};

describe("parseReplayFilters", () => {
  it("returns defaults for empty input", () => {
    expect(parseReplayFilters({})).toEqual(DEFAULTS);
  });

  it("trims and caps q length", () => {
    const long = "x".repeat(500);
    expect(parseReplayFilters({ q: `  hello  ` }).q).toBe("hello");
    expect(parseReplayFilters({ q: long }).q.length).toBe(200);
  });

  it("accepts errors=true or errors=1", () => {
    expect(parseReplayFilters({ errors: "true" }).errorsOnly).toBe(true);
    expect(parseReplayFilters({ errors: "TRUE" }).errorsOnly).toBe(true);
    expect(parseReplayFilters({ errors: "1" }).errorsOnly).toBe(true);
    expect(parseReplayFilters({ errors: "false" }).errorsOnly).toBe(false);
    expect(parseReplayFilters({ errors: "" }).errorsOnly).toBe(false);
  });

  it("validates since window", () => {
    expect(parseReplayFilters({ since: "24h" }).since).toBe("24h");
    expect(parseReplayFilters({ since: "7d" }).since).toBe("7d");
    expect(parseReplayFilters({ since: "30d" }).since).toBe("30d");
    expect(parseReplayFilters({ since: "all" }).since).toBe("all");
    expect(parseReplayFilters({ since: "nope" }).since).toBe("7d"); // invalid → default
  });

  it("clamps page to [1, MAX_PAGE]", () => {
    expect(parseReplayFilters({ page: "1" }).page).toBe(1);
    expect(parseReplayFilters({ page: "42" }).page).toBe(42);
    expect(parseReplayFilters({ page: "0" }).page).toBe(1);
    expect(parseReplayFilters({ page: "-5" }).page).toBe(1);
    expect(parseReplayFilters({ page: "999999" }).page).toBe(1000);
    expect(parseReplayFilters({ page: "abc" }).page).toBe(1);
  });

  it("takes first element when param is an array", () => {
    expect(parseReplayFilters({ q: ["first", "second"] }).q).toBe("first");
  });

  it("trims and caps fingerprint", () => {
    expect(parseReplayFilters({ fingerprint: "  abc123  " }).fingerprint).toBe("abc123");
    expect(parseReplayFilters({ fingerprint: "x".repeat(200) }).fingerprint.length).toBe(100);
  });

  it("trims and caps urlPath", () => {
    expect(parseReplayFilters({ urlPath: " /cart " }).urlPath).toBe("/cart");
    expect(parseReplayFilters({ urlPath: "x".repeat(800) }).urlPath.length).toBe(500);
  });

  it("parses dateFrom as UTC midnight", () => {
    const f = parseReplayFilters({ dateFrom: "2026-04-14" });
    expect(f.dateFrom?.toISOString()).toBe("2026-04-14T00:00:00.000Z");
  });

  it("parses dateTo as end of UTC day (inclusive)", () => {
    const f = parseReplayFilters({ dateTo: "2026-04-14" });
    expect(f.dateTo?.toISOString()).toBe("2026-04-14T23:59:59.999Z");
  });

  it("ignores invalid dates", () => {
    const f = parseReplayFilters({ dateFrom: "not-a-date", dateTo: "" });
    expect(f.dateFrom).toBeNull();
    expect(f.dateTo).toBeNull();
  });

  it("parses hasRageClicks / hasDeadClicks toggles", () => {
    expect(parseReplayFilters({ hasRageClicks: "true" }).hasRageClicks).toBe(true);
    expect(parseReplayFilters({ hasRageClicks: "1" }).hasRageClicks).toBe(true);
    expect(parseReplayFilters({ hasRageClicks: "false" }).hasRageClicks).toBe(false);
    expect(parseReplayFilters({ hasDeadClicks: "TRUE" }).hasDeadClicks).toBe(true);
  });

  it("validates sortBy and sortDir", () => {
    expect(parseReplayFilters({ sortBy: "durationMs" }).sortBy).toBe("durationMs");
    expect(parseReplayFilters({ sortBy: "totalBytes" }).sortBy).toBe("totalBytes");
    expect(parseReplayFilters({ sortBy: "evil" }).sortBy).toBe("createdAt");
    expect(parseReplayFilters({ sortDir: "asc" }).sortDir).toBe("asc");
    expect(parseReplayFilters({ sortDir: "DESC" }).sortDir).toBe("desc");
    expect(parseReplayFilters({ sortDir: "sideways" }).sortDir).toBe("desc");
  });
});

describe("sinceToDate", () => {
  const now = new Date("2026-04-14T12:00:00Z");

  it("returns null for 'all'", () => {
    expect(sinceToDate("all", now)).toBeNull();
  });

  it("computes the correct offsets", () => {
    expect(sinceToDate("24h", now)!.toISOString()).toBe("2026-04-13T12:00:00.000Z");
    expect(sinceToDate("7d", now)!.toISOString()).toBe("2026-04-07T12:00:00.000Z");
    expect(sinceToDate("30d", now)!.toISOString()).toBe("2026-03-15T12:00:00.000Z");
  });
});

describe("hasActiveFilters", () => {
  it("false for defaults only", () => {
    expect(hasActiveFilters(parseReplayFilters({}))).toBe(false);
  });

  it("true when any non-default filter is set", () => {
    expect(hasActiveFilters(parseReplayFilters({ q: "hello" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ errors: "true" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ browser: "Chrome" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ since: "24h" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ fingerprint: "abc" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ urlPath: "/cart" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ dateFrom: "2026-04-01" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ sortBy: "durationMs" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ sortDir: "asc" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ hasRageClicks: "true" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ hasDeadClicks: "true" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ endUserId: "u_42" }))).toBe(true);
    expect(hasActiveFilters(parseReplayFilters({ endUserEmail: "x@y.com" }))).toBe(true);
  });
});

describe("toLikePattern", () => {
  it("wraps plain text in %", () => {
    expect(toLikePattern("hello")).toBe("%hello%");
  });

  it("escapes LIKE metacharacters to prevent wildcard injection", () => {
    expect(toLikePattern("50%_off")).toBe("%50\\%\\_off%");
    expect(toLikePattern("path\\sub")).toBe("%path\\\\sub%");
  });
});

describe("paginationInfo", () => {
  it("computes totalPages and offset", () => {
    expect(paginationInfo(1, 0)).toEqual({ page: 1, totalPages: 1, offset: 0, limit: PAGE_SIZE });
    expect(paginationInfo(1, 50)).toEqual({ page: 1, totalPages: 1, offset: 0, limit: PAGE_SIZE });
    expect(paginationInfo(2, 100)).toEqual({ page: 2, totalPages: 2, offset: 50, limit: PAGE_SIZE });
    expect(paginationInfo(3, 120)).toEqual({ page: 3, totalPages: 3, offset: 100, limit: PAGE_SIZE });
  });

  it("clamps out-of-range pages", () => {
    expect(paginationInfo(0, 100).page).toBe(1);
    expect(paginationInfo(-5, 100).page).toBe(1);
    expect(paginationInfo(99999, 100).page).toBe(1000);
  });
});

describe("dateToInputValue", () => {
  it("formats Date as YYYY-MM-DD UTC", () => {
    expect(dateToInputValue(new Date("2026-04-14T00:00:00Z"))).toBe("2026-04-14");
    expect(dateToInputValue(new Date("2026-04-14T23:59:59.999Z"))).toBe("2026-04-14");
  });

  it("returns empty for null/undefined", () => {
    expect(dateToInputValue(null)).toBe("");
    expect(dateToInputValue(undefined)).toBe("");
  });
});

describe("filtersToSearchString", () => {
  it("omits defaults", () => {
    expect(filtersToSearchString({})).toBe("");
    expect(filtersToSearchString({ since: "7d" })).toBe(""); // default window
    expect(filtersToSearchString({ page: 1 })).toBe(""); // default page
    expect(filtersToSearchString({ sortBy: "createdAt", sortDir: "desc" })).toBe("");
  });

  it("encodes non-defaults", () => {
    expect(filtersToSearchString({ q: "submit", errorsOnly: true }))
      .toBe("q=submit&errors=true");
    expect(filtersToSearchString({ browser: "Chrome", since: "24h", page: 3 }))
      .toBe("browser=Chrome&since=24h&page=3");
  });

  it("encodes new filter fields", () => {
    expect(filtersToSearchString({ fingerprint: "abc", urlPath: "/cart" }))
      .toBe("fingerprint=abc&urlPath=%2Fcart");
    expect(filtersToSearchString({ sortBy: "durationMs", sortDir: "asc" }))
      .toBe("sortBy=durationMs&sortDir=asc");
    expect(filtersToSearchString({ dateFrom: new Date("2026-04-14T00:00:00Z") }))
      .toBe("dateFrom=2026-04-14");
    expect(filtersToSearchString({ hasRageClicks: true, hasDeadClicks: true }))
      .toBe("hasRageClicks=true&hasDeadClicks=true");
    expect(filtersToSearchString({ endUserId: "u_42", endUserEmail: "j@a.com" }))
      .toBe("endUserId=u_42&endUserEmail=j%40a.com");
  });

  it("roundtrips through parseReplayFilters", () => {
    const original = parseReplayFilters({
      q: "hello",
      errors: "true",
      browser: "Firefox",
      since: "30d",
      page: "5",
      fingerprint: "abc",
      urlPath: "/checkout",
      dateFrom: "2026-04-01",
      dateTo: "2026-04-14",
      sortBy: "durationMs",
      sortDir: "asc",
      hasRageClicks: "true",
      hasDeadClicks: "true",
      endUserId: "u_42",
      endUserEmail: "juan@acme.com",
    });
    const qs = filtersToSearchString(original);
    const params = new URLSearchParams(qs);
    const reparsed = parseReplayFilters(Object.fromEntries(params.entries()));
    expect(reparsed).toEqual(original);
  });
});
