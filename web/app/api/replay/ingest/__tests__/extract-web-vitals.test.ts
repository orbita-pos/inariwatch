import { describe, it, expect } from "vitest";
import { extractWebVitals } from "../helpers";

const v = (name: string, value: number, rating = "good") => ({
  _kind: "vital",
  timestamp: 100,
  name,
  value,
  rating,
});

describe("extractWebVitals", () => {
  it("returns {} for empty input", () => {
    expect(extractWebVitals([])).toEqual({});
  });

  it("ignores non-vital events", () => {
    expect(extractWebVitals([{ _kind: "console" }, { type: 3 }, null, "x"])).toEqual({});
  });

  it("extracts the 5 supported vitals", () => {
    const out = extractWebVitals([
      v("LCP", 2400),
      v("CLS", 0.12, "needs-improvement"),
      v("INP", 220, "needs-improvement"),
      v("FCP", 1800),
      v("TTFB", 600),
    ]);
    expect(Object.keys(out).sort()).toEqual(["CLS", "FCP", "INP", "LCP", "TTFB"]);
    expect(out.LCP).toEqual({ value: 2400, rating: "good" });
    expect(out.CLS).toEqual({ value: 0.12, rating: "needs-improvement" });
  });

  it("rejects unknown vital names", () => {
    expect(extractWebVitals([v("FAKE", 100)])).toEqual({});
  });

  it("rejects invalid ratings", () => {
    expect(extractWebVitals([v("LCP", 1000, "weird")])).toEqual({});
  });

  it("rejects non-numeric / negative / NaN values", () => {
    expect(extractWebVitals([v("LCP", -1)])).toEqual({});
    expect(extractWebVitals([v("LCP", NaN)])).toEqual({});
    expect(extractWebVitals([{ _kind: "vital", name: "LCP", value: "fast", rating: "good" }])).toEqual({});
  });

  it("later event for same metric overwrites earlier (canonical = last)", () => {
    const out = extractWebVitals([
      v("LCP", 1000, "good"),
      v("LCP", 4500, "poor"),
    ]);
    expect(out.LCP).toEqual({ value: 4500, rating: "poor" });
  });

  it("zero is a valid value (e.g. CLS=0)", () => {
    const out = extractWebVitals([v("CLS", 0, "good")]);
    expect(out.CLS).toEqual({ value: 0, rating: "good" });
  });
});
