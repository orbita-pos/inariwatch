import { describe, it, expect } from "vitest";
import {
  parseReplayFilters,
  sinceToDate,
  hasActiveFilters,
  toLikePattern,
  paginationInfo,
  filtersToSearchString,
  PAGE_SIZE,
} from "../replay-filters";

describe("parseReplayFilters", () => {
  it("returns defaults for empty input", () => {
    const f = parseReplayFilters({});
    expect(f).toEqual({ q: "", errorsOnly: false, browser: "", since: "7d", page: 1 });
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

describe("filtersToSearchString", () => {
  it("omits defaults", () => {
    expect(filtersToSearchString({})).toBe("");
    expect(filtersToSearchString({ since: "7d" })).toBe(""); // default window
    expect(filtersToSearchString({ page: 1 })).toBe(""); // default page
  });

  it("encodes non-defaults", () => {
    expect(filtersToSearchString({ q: "submit", errorsOnly: true }))
      .toBe("q=submit&errors=true");
    expect(filtersToSearchString({ browser: "Chrome", since: "24h", page: 3 }))
      .toBe("browser=Chrome&since=24h&page=3");
  });

  it("roundtrips through parseReplayFilters", () => {
    const original = parseReplayFilters({ q: "hello", errors: "true", browser: "Firefox", since: "30d", page: "5" });
    const qs = filtersToSearchString(original);
    const params = new URLSearchParams(qs);
    const reparsed = parseReplayFilters(Object.fromEntries(params.entries()));
    expect(reparsed).toEqual(original);
  });
});
