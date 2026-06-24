/**
 * Tests for the desktop snooze parser. Mirror of
 * `web/lib/conversations/__tests__/snooze-parser.test.ts` —
 * the implementations are intentionally duplicated so the codebases
 * stay decoupled. Both test files exercise the same grammar.
 */

import { describe, expect, test } from "vitest";

import { parseSnoozeUntil } from "../snooze-parser";

const NOW = new Date("2026-05-08T15:30:00Z");

describe("desktop snooze-parser", () => {
  test("rejects empty input", () => {
    expect("error" in parseSnoozeUntil("", NOW)).toBe(true);
  });

  test("relative duration: 30m", () => {
    const r = parseSnoozeUntil("30m", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getTime() - NOW.getTime()).toBe(30 * 60_000);
  });

  test("relative duration: 2h", () => {
    const r = parseSnoozeUntil("2h", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getTime() - NOW.getTime()).toBe(2 * 3_600_000);
  });

  test("clock with am/pm", () => {
    const r = parseSnoozeUntil("9:30am", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getHours()).toBe(9);
    expect(r.until.getMinutes()).toBe(30);
  });

  test("tomorrow defaults to 9am", () => {
    const r = parseSnoozeUntil("tomorrow", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getHours()).toBe(9);
  });

  test("monday rolls forward when today is friday", () => {
    const r = parseSnoozeUntil("monday", NOW);
    if (!("until" in r)) throw new Error("expected until");
    expect(r.until.getDay()).toBe(1);
  });

  test("garbage rejected", () => {
    expect("error" in parseSnoozeUntil("zorp", NOW)).toBe(true);
  });

  test("ISO date in past rejected", () => {
    expect("error" in parseSnoozeUntil("2020-01-01", NOW)).toBe(true);
  });
});
