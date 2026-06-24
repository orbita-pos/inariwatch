/**
 * Pure-module tests for the flexible snooze parser. Pin time via the
 * `now` arg so test results are deterministic across CI machines.
 */

import { describe, expect, test } from "vitest";

import { parseSnoozeUntil } from "../snooze-parser";

const NOW = new Date("2026-05-08T15:30:00Z"); // Friday 15:30 UTC

describe("snooze-parser", () => {
  test("rejects empty input", () => {
    const r = parseSnoozeUntil("", NOW);
    expect("error" in r).toBe(true);
  });

  test("relative duration: 30m", () => {
    const r = parseSnoozeUntil("30m", NOW);
    expect("until" in r).toBe(true);
    if ("until" in r) {
      expect(r.until.getTime() - NOW.getTime()).toBe(30 * 60_000);
    }
  });

  test("relative duration: 2h", () => {
    const r = parseSnoozeUntil("2h", NOW);
    expect("until" in r).toBe(true);
    if ("until" in r) {
      expect(r.until.getTime() - NOW.getTime()).toBe(2 * 3_600_000);
    }
  });

  test("relative duration: 7d", () => {
    const r = parseSnoozeUntil("7d", NOW);
    expect("until" in r).toBe(true);
    if ("until" in r) {
      expect(r.until.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
    }
  });

  test("relative duration: 1week alias", () => {
    const r = parseSnoozeUntil("1week", NOW);
    expect("until" in r).toBe(true);
    if ("until" in r) {
      expect(r.until.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
    }
  });

  test("zero or negative durations are rejected", () => {
    expect("error" in parseSnoozeUntil("0h", NOW)).toBe(true);
  });

  test("clock time future today: 5pm", () => {
    // 15:30 UTC + "5pm" expressed in local. Just assert hours/mins look right.
    const r = parseSnoozeUntil("5pm", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getHours()).toBe(17);
    expect(r.until.getMinutes()).toBe(0);
  });

  test("clock time past today rolls to tomorrow", () => {
    const morningNow = new Date("2026-05-08T18:00:00Z"); // late
    const r = parseSnoozeUntil("9am", morningNow);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getHours()).toBe(9);
    // Should be at least the next calendar day.
    const startOfToday = new Date(morningNow);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday.getTime() + 86_400_000);
    expect(r.until.getTime()).toBeGreaterThanOrEqual(startOfTomorrow.getTime());
  });

  test("12-hour clock with minutes: 9:30am", () => {
    const r = parseSnoozeUntil("9:30am", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getHours()).toBe(9);
    expect(r.until.getMinutes()).toBe(30);
  });

  test("24-hour clock: 14:00", () => {
    const r = parseSnoozeUntil("14:00", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getHours()).toBe(14);
    expect(r.until.getMinutes()).toBe(0);
  });

  test("12pm = noon, 12am = midnight", () => {
    const noon = parseSnoozeUntil("12pm", NOW);
    const midnight = parseSnoozeUntil("12am", NOW);
    if (!("until" in noon) || !("until" in midnight)) throw new Error("expected untils");
    expect(noon.until.getHours()).toBe(12);
    expect(midnight.until.getHours()).toBe(0);
  });

  test("tomorrow defaults to 9am", () => {
    const r = parseSnoozeUntil("tomorrow", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getHours()).toBe(9);
    expect(r.until.getMinutes()).toBe(0);
    // Day after NOW.
    expect(r.until.getDate()).toBe(NOW.getDate() + 1);
  });

  test("tomorrow 5pm", () => {
    const r = parseSnoozeUntil("tomorrow 5pm", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getHours()).toBe(17);
  });

  test("day-of-week: monday", () => {
    // 2026-05-08 is a Friday. Next Monday is 2026-05-11.
    const r = parseSnoozeUntil("monday", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getDay()).toBe(1); // Monday
    expect(r.until.getHours()).toBe(9);
  });

  test("same day-of-week rolls to next week", () => {
    // 2026-05-08 is Friday → "friday" should roll forward.
    const r = parseSnoozeUntil("friday", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getDay()).toBe(5);
    // Strictly after now.
    expect(r.until.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("ISO timestamp parses", () => {
    const r = parseSnoozeUntil("2026-05-12t14:00", NOW);
    expect("until" in r).toBe(true);
  });

  test("ISO date in the past rejected", () => {
    const r = parseSnoozeUntil("2020-01-01", NOW);
    expect("error" in r).toBe(true);
  });

  test("garbage input returns error", () => {
    const r = parseSnoozeUntil("zorp the magnificent", NOW);
    expect("error" in r).toBe(true);
  });

  test("clock with malformed minutes rejected", () => {
    const r = parseSnoozeUntil("9:99am", NOW);
    expect("error" in r).toBe(true);
  });
});
