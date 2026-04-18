/**
 * Tests for the UUID_REGEX / isUuid shared validator.
 * L3 fix — tightens the loose /^[0-9a-f-]{36}$/i pattern that used to
 * accept any 36-char hex+dash blob and surface as 500 from drizzle.
 */

import { describe, it, expect } from "vitest";
import { UUID_REGEX, isUuid } from "../validation";

describe("UUID_REGEX — strict RFC 4122 shape", () => {
  it("accepts canonical UUID v4", () => {
    expect(UUID_REGEX.test("d0e9e62e-b08e-4dd8-89ca-08ab142019ee")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(UUID_REGEX.test("D0E9E62E-B08E-4DD8-89CA-08AB142019EE")).toBe(true);
  });

  it("rejects 36 hex chars with hyphens in wrong positions", () => {
    expect(UUID_REGEX.test("d0e9e62eb08e-4dd8-89ca-08ab142019eeab")).toBe(false);
  });

  it("rejects 36 dashes", () => {
    expect(UUID_REGEX.test("------------------------------------")).toBe(false);
  });

  it("rejects mixed hex+dashes without structure (the loose pattern gap)", () => {
    // The old /^[0-9a-f-]{36}$/i would accept this; strict rejects.
    expect(UUID_REGEX.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(UUID_REGEX.test("g0e9e62e-b08e-4dd8-89ca-08ab142019ee")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(UUID_REGEX.test("")).toBe(false);
  });

  it("rejects null / undefined / number inputs via isUuid", () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid({})).toBe(false);
  });

  it("isUuid narrows type + matches canonical shape", () => {
    const v: unknown = "d0e9e62e-b08e-4dd8-89ca-08ab142019ee";
    expect(isUuid(v)).toBe(true);
  });
});
