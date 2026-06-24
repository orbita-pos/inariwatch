import { describe, it, expect } from "vitest";
import { detectRageClicks } from "../replay-rage-click";

const click = (ts: number, selector: string) => ({
  type: 3,
  timestamp: ts,
  data: { source: 2, type: 2, selector },
});

const otherEvent = (ts: number) => ({ type: 3, timestamp: ts, data: { source: 0 } });

describe("detectRageClicks", () => {
  it("returns [] for empty input", () => {
    expect(detectRageClicks([])).toEqual([]);
  });

  it("returns [] when only non-click events present", () => {
    expect(detectRageClicks([otherEvent(100), otherEvent(200)])).toEqual([]);
  });

  it("does not flag 2 clicks (below MIN_CLICKS=3)", () => {
    expect(detectRageClicks([click(100, "button.x"), click(200, "button.x")])).toEqual([]);
  });

  it("flags 3 clicks within 1000ms on the same selector", () => {
    const out = detectRageClicks([
      click(100, "button.submit"),
      click(400, "button.submit"),
      click(700, "button.submit"),
    ]);
    expect(out).toEqual([{ timestamp: 700, selector: "button.submit", count: 3 }]);
  });

  it("does NOT flag 3 clicks spanning more than 1000ms", () => {
    expect(detectRageClicks([
      click(0, "button.x"),
      click(500, "button.x"),
      // 1100 is > 1000ms after click[0] = 0 → falls outside the window
      click(1100, "button.x"),
    ])).toEqual([]);
  });

  it("does NOT flag clicks on different selectors even if within window", () => {
    expect(detectRageClicks([
      click(100, "a.foo"),
      click(200, "a.bar"),
      click(300, "a.baz"),
    ])).toEqual([]);
  });

  it("counts the full run length, not just the first 3", () => {
    const out = detectRageClicks([
      click(0, "div.icon"),
      click(200, "div.icon"),
      click(400, "div.icon"),
      click(600, "div.icon"),
      click(800, "div.icon"),
    ]);
    expect(out).toEqual([{ timestamp: 800, selector: "div.icon", count: 5 }]);
  });

  it("starts a new window after a run closes (no overlap)", () => {
    const out = detectRageClicks([
      // First rage burst
      click(100, "button.x"),
      click(300, "button.x"),
      click(500, "button.x"),
      // Cool-off, then second burst on same selector — should be a separate detection
      click(2000, "button.x"),
      click(2200, "button.x"),
      click(2400, "button.x"),
    ]);
    expect(out).toEqual([
      { timestamp: 500, selector: "button.x", count: 3 },
      { timestamp: 2400, selector: "button.x", count: 3 },
    ]);
  });

  it("sorts unsorted input before scanning", () => {
    const out = detectRageClicks([
      click(700, "button.submit"),
      click(100, "button.submit"),
      click(400, "button.submit"),
    ]);
    expect(out).toEqual([{ timestamp: 700, selector: "button.submit", count: 3 }]);
  });

  it("treats missing selector as empty-string and groups them together", () => {
    const e = (ts: number) => ({ type: 3, timestamp: ts, data: { source: 2, type: 2 } });
    expect(detectRageClicks([e(100), e(300), e(600)])).toEqual([
      { timestamp: 600, selector: "", count: 3 },
    ]);
  });

  it("ignores non-click events interleaved with clicks", () => {
    const out = detectRageClicks([
      click(100, "button.x"),
      otherEvent(150),
      click(300, "button.x"),
      otherEvent(350),
      click(500, "button.x"),
    ]);
    expect(out).toEqual([{ timestamp: 500, selector: "button.x", count: 3 }]);
  });
});
