import { describe, it, expect } from "vitest";
import { isExpired, ABSOLUTE_MAX_RETENTION_DAYS } from "../replay-retention-pure";

const NOW = new Date("2026-04-15T12:00:00Z");
const day = (offsetDays: number) =>
  new Date(NOW.getTime() - offsetDays * 24 * 60 * 60 * 1000);

describe("isExpired", () => {
  it("keeps a session younger than retentionDays", () => {
    expect(isExpired(day(3), 7, NOW)).toBe(false);
    expect(isExpired(day(6.9), 7, NOW)).toBe(false);
  });

  it("expires a session at exactly retentionDays", () => {
    expect(isExpired(day(7), 7, NOW)).toBe(true);
  });

  it("expires a session older than retentionDays", () => {
    expect(isExpired(day(8), 7, NOW)).toBe(true);
    expect(isExpired(day(90), 7, NOW)).toBe(true);
  });

  it("falls back to default (7) when retentionDays is null/undefined", () => {
    expect(isExpired(day(8), null, NOW)).toBe(true);
    expect(isExpired(day(8), undefined, NOW)).toBe(true);
    expect(isExpired(day(6), null, NOW)).toBe(false);
  });

  it("clamps absurdly large retentionDays to the absolute maximum", () => {
    // 367 days old, customer requested 9999-day retention → still deleted
    expect(isExpired(day(ABSOLUTE_MAX_RETENTION_DAYS + 1), 9999, NOW)).toBe(true);
    // 365 days old, requested 9999 → kept (within absolute max)
    expect(isExpired(day(ABSOLUTE_MAX_RETENTION_DAYS - 1), 9999, NOW)).toBe(false);
  });

  it("clamps non-positive retentionDays to 1 day (zero would delete on creation)", () => {
    expect(isExpired(day(0.5), 0, NOW)).toBe(false);
    expect(isExpired(day(2), -5, NOW)).toBe(true);
  });

  it("is robust to tiny clock drift (no false expiration on now == createdAt)", () => {
    expect(isExpired(NOW, 7, NOW)).toBe(false);
  });
});
