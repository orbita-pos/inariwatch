import { describe, expect, it } from "vitest";

// Import from the pure module to keep this suite hermetic — the
// DB-aware re-exports in `state.ts` would pull in @/lib/db which
// requires DATABASE_URL. The pure transition rules are exactly what
// these tests need to verify.
import {
  PROJECT_STATES,
  isValidTransition,
  type ProjectState,
} from "../state-machine";

describe("project state machine — transition matrix", () => {
  it("enumerates exactly seven canonical states", () => {
    expect(PROJECT_STATES).toEqual([
      "created",
      "needs_setup",
      "setting_up",
      "prepared",
      "verified",
      "live",
      "archived",
    ]);
  });

  it("allows the canonical happy-path edges", () => {
    expect(isValidTransition("created", "needs_setup")).toBe(true);
    expect(isValidTransition("needs_setup", "setting_up")).toBe(true);
    expect(isValidTransition("setting_up", "prepared")).toBe(true);
    expect(isValidTransition("prepared", "verified")).toBe(true);
    expect(isValidTransition("verified", "live")).toBe(true);
  });

  it("allows archive from every non-archived state", () => {
    const archivable: ProjectState[] = [
      "created",
      "needs_setup",
      "setting_up",
      "prepared",
      "verified",
      "live",
    ];
    for (const from of archivable) {
      expect(isValidTransition(from, "archived")).toBe(true);
    }
  });

  it("rejects skipping states forward (e.g. created → setting_up)", () => {
    expect(isValidTransition("created", "setting_up")).toBe(false);
    expect(isValidTransition("created", "prepared")).toBe(false);
    expect(isValidTransition("needs_setup", "verified")).toBe(false);
    expect(isValidTransition("setting_up", "verified")).toBe(false);
  });

  it("allows wizard restart edges (setting_up → needs_setup, prepared → needs_setup)", () => {
    // The wizard's "Cancel" button needs to roll a project BACK if the
    // user aborts mid-install. Both edges are explicit because each maps
    // to a distinct UX moment (mid-install abort vs. after-install
    // abort).
    expect(isValidTransition("setting_up", "needs_setup")).toBe(true);
    expect(isValidTransition("prepared", "needs_setup")).toBe(true);
  });

  it("rejects backward edges from verified/live (no replay)", () => {
    expect(isValidTransition("verified", "prepared")).toBe(false);
    expect(isValidTransition("live", "prepared")).toBe(false);
    expect(isValidTransition("live", "verified")).toBe(false);
  });

  it("rejects every edge OUT of archived (terminal state)", () => {
    for (const to of PROJECT_STATES) {
      if (to === "archived") continue;
      expect(isValidTransition("archived", to)).toBe(false);
    }
  });

  it("rejects self-loops (mask wizard bugs)", () => {
    for (const state of PROJECT_STATES) {
      expect(isValidTransition(state, state)).toBe(false);
    }
  });
});
