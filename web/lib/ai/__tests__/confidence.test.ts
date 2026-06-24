import { describe, it, expect } from "vitest";
import {
  confidenceTier,
  confidenceEmoji,
  confidenceClasses,
  confidenceLabel,
  confidenceShortLabel,
} from "../confidence";

describe("confidenceTier", () => {
  it("green for >=80", () => {
    expect(confidenceTier(80)).toBe("green");
    expect(confidenceTier(95)).toBe("green");
    expect(confidenceTier(100)).toBe("green");
  });

  it("yellow for 60-79", () => {
    expect(confidenceTier(60)).toBe("yellow");
    expect(confidenceTier(70)).toBe("yellow");
    expect(confidenceTier(79)).toBe("yellow");
  });

  it("red for <60", () => {
    expect(confidenceTier(0)).toBe("red");
    expect(confidenceTier(50)).toBe("red");
    expect(confidenceTier(59)).toBe("red");
  });

  it("null/undefined -> red (no signal = worst case)", () => {
    expect(confidenceTier(null)).toBe("red");
    expect(confidenceTier(undefined)).toBe("red");
    expect(confidenceTier(NaN)).toBe("red");
    expect(confidenceTier(Infinity)).toBe("red");
  });
});

describe("confidenceEmoji", () => {
  it("maps each tier", () => {
    expect(confidenceEmoji("green")).toBe("🟢");
    expect(confidenceEmoji("yellow")).toBe("🟡");
    expect(confidenceEmoji("red")).toBe("🔴");
  });
});

describe("confidenceClasses", () => {
  it("returns class triples per tier", () => {
    const green = confidenceClasses("green");
    expect(green.text).toContain("emerald");
    expect(green.bg).toContain("emerald");
    const yellow = confidenceClasses("yellow");
    expect(yellow.text).toContain("amber");
    const red = confidenceClasses("red");
    expect(red.text).toContain("red");
  });
});

describe("confidenceLabel", () => {
  it("formats green with 'safe to auto-merge'", () => {
    expect(confidenceLabel(87)).toBe("🟢 87% — safe to auto-merge");
  });

  it("formats yellow with 'review recommended'", () => {
    expect(confidenceLabel(72)).toBe("🟡 72% — review recommended");
  });

  it("formats red with 'escalated'", () => {
    expect(confidenceLabel(41)).toBe("🔴 41% — escalated");
  });

  it("handles null", () => {
    expect(confidenceLabel(null)).toBe("🔴 — — escalated");
  });

  it("appends gate count when given", () => {
    expect(confidenceLabel(85, 15, 17)).toBe("🟢 85% — safe to auto-merge · 15/17 gates");
  });

  it("rounds percentages independent of tier", () => {
    // Tier is computed from the raw value, then the displayed pct is
    // rounded. So 79.9 stays yellow (below 80 threshold) even though
    // it displays as "80%".
    expect(confidenceLabel(87.6)).toBe("🟢 88% — safe to auto-merge");
    expect(confidenceLabel(79.9)).toBe("🟡 80% — review recommended");
    expect(confidenceLabel(79.4)).toBe("🟡 79% — review recommended");
    expect(confidenceLabel(80.0)).toBe("🟢 80% — safe to auto-merge");
  });
});

describe("confidenceShortLabel", () => {
  it("emoji + rounded percent", () => {
    expect(confidenceShortLabel(87)).toBe("🟢 87%");
    expect(confidenceShortLabel(72)).toBe("🟡 72%");
    expect(confidenceShortLabel(41)).toBe("🔴 41%");
  });

  it("handles null", () => {
    expect(confidenceShortLabel(null)).toBe("🔴 —");
  });
});
