import { describe, expect, it } from "vitest";

import {
  DID_YOU_MEAN_THRESHOLD,
  closestCommandName,
  formatUnknownCommand,
  levenshtein,
} from "../error-help";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("foo", "foo")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  it("returns string length when one side is empty", () => {
    expect(levenshtein("", "hello")).toBe(5);
    expect(levenshtein("hello", "")).toBe(5);
  });

  it("counts single-character substitutions", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("counts insertions + deletions", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  it("counts transpositions as 2 edits (not 1 — strict Levenshtein, not DL)", () => {
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  it("is symmetric", () => {
    expect(levenshtein("projects", "projetcs")).toBe(
      levenshtein("projetcs", "projects"),
    );
  });

  it("handles longer strings (regression for the rolling-row swap)", () => {
    // Distance 4 — replace each consonant pair.
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("closestCommandName", () => {
  it("returns null for an empty typed string", () => {
    expect(closestCommandName("")).toBeNull();
    expect(closestCommandName("   ")).toBeNull();
  });

  it("suggests /alerts for /alrts (distance 1)", () => {
    expect(closestCommandName("alrts")).toBe("/alerts");
  });

  it("suggests /projects for /projetcs (transposition, distance 2)", () => {
    expect(closestCommandName("projetcs")).toBe("/projects");
  });

  it("suggests /install for /instll (distance 1)", () => {
    expect(closestCommandName("instll")).toBe("/install");
  });

  it("suggests /oncall for /oncal (distance 1)", () => {
    expect(closestCommandName("oncal")).toBe("/oncall");
  });

  it("is case-insensitive on the typed string", () => {
    expect(closestCommandName("PROJETCS")).toBe("/projects");
  });

  it("returns null when nothing is within the threshold", () => {
    // "completelyunrelatedtext" has no manifest entry within edit
    // distance 3.
    expect(closestCommandName("completelyunrelatedtext")).toBeNull();
  });

  it("prefers the exact-match command when one exists (distance 0)", () => {
    // Defensive — if the dispatcher's catalog-miss path EVER calls
    // this for a known command, we should still surface it cleanly.
    expect(closestCommandName("projects")).toBe("/projects");
  });

  it("threshold of 3 is the documented constant", () => {
    // Constant pinned by re-export so callers (or A/B tests) can
    // depend on the value without re-deriving it.
    expect(DID_YOU_MEAN_THRESHOLD).toBe(3);
  });
});

describe("formatUnknownCommand", () => {
  it("includes the did-you-mean hint when a close match exists", () => {
    const msg = formatUnknownCommand("alrts");
    expect(msg).toMatch(/Unknown command `\/alrts`/);
    expect(msg).toMatch(/Did you mean `\/alerts`\?/);
    expect(msg).toMatch(/`\/help`/);
  });

  it("falls back to the plain hint when no close match exists", () => {
    const msg = formatUnknownCommand("completelyunrelatedtext");
    expect(msg).toMatch(/Unknown command `\/completelyunrelatedtext`/);
    expect(msg).not.toMatch(/Did you mean/);
    expect(msg).toMatch(/`\/help`/);
  });

  it("works with very short typed strings", () => {
    // `/x` — too few chars to make a useful Levenshtein call, but the
    // function should not throw and should fall through cleanly.
    const msg = formatUnknownCommand("x");
    expect(msg).toMatch(/Unknown command `\/x`/);
  });
});
