import { describe, it, expect } from "vitest";
import { detectDeadClicks } from "../replay-dead-click";

const click = (ts: number, selector = "button.x") => ({
  type: 3,
  timestamp: ts,
  data: { source: 2, type: 2, selector },
});

const mutation = (ts: number) => ({ type: 3, timestamp: ts, data: { source: 0 } });

const navMeta = (ts: number, href = "https://app/x") => ({
  type: 4,
  timestamp: ts,
  data: { href, width: 1024, height: 768 },
});

const navCustom = (ts: number, href = "https://app/y") => ({
  _kind: "nav",
  timestamp: ts,
  href,
});

describe("detectDeadClicks", () => {
  it("returns [] for empty input", () => {
    expect(detectDeadClicks([])).toEqual([]);
  });

  it("flags a click followed by zero mutations", () => {
    const out = detectDeadClicks([click(100, "button.dead")]);
    expect(out).toEqual([
      { timestamp: 100, selector: "button.dead", mutationsAfter: 0 },
    ]);
  });

  it("does NOT flag a click followed by >= 5 mutations within 3s", () => {
    const out = detectDeadClicks([
      click(100),
      mutation(200),
      mutation(300),
      mutation(400),
      mutation(500),
      mutation(600),
    ]);
    expect(out).toEqual([]);
  });

  it("flags a click with only 4 mutations (below threshold)", () => {
    const out = detectDeadClicks([
      click(100, "button.barely-alive"),
      mutation(200),
      mutation(300),
      mutation(400),
      mutation(500),
    ]);
    expect(out).toEqual([
      { timestamp: 100, selector: "button.barely-alive", mutationsAfter: 4 },
    ]);
  });

  it("ignores mutations that fall outside the 3s window", () => {
    const out = detectDeadClicks([
      click(100, "button.x"),
      // Five mutations but all > 3000ms after the click → click is dead
      mutation(3200),
      mutation(3300),
      mutation(3400),
      mutation(3500),
      mutation(3600),
    ]);
    expect(out).toEqual([
      { timestamp: 100, selector: "button.x", mutationsAfter: 0 },
    ]);
  });

  it("does NOT flag a click that triggers an rrweb meta nav (type=4)", () => {
    const out = detectDeadClicks([
      click(100, "a.link"),
      navMeta(150),
    ]);
    expect(out).toEqual([]);
  });

  it("does NOT flag a click that triggers a custom nav (_kind:nav)", () => {
    const out = detectDeadClicks([
      click(100, "a.link"),
      navCustom(250),
    ]);
    expect(out).toEqual([]);
  });

  it("DOES flag a click followed by a nav AFTER the 3s window", () => {
    const out = detectDeadClicks([
      click(100, "a.lazy"),
      navCustom(5000),
    ]);
    expect(out).toEqual([
      { timestamp: 100, selector: "a.lazy", mutationsAfter: 0 },
    ]);
  });

  it("ignores mutations that fire AT the click timestamp (must be strictly after)", () => {
    const out = detectDeadClicks([
      click(100),
      mutation(100),
      mutation(100),
      mutation(100),
      mutation(100),
      mutation(100),
    ]);
    expect(out).toEqual([
      { timestamp: 100, selector: "button.x", mutationsAfter: 0 },
    ]);
  });

  it("skips clicks whose timestamp is in excludeTimestamps", () => {
    const out = detectDeadClicks(
      [click(100, "button.rage"), click(500, "button.normal")],
      new Set([100]),
    );
    expect(out).toEqual([
      { timestamp: 500, selector: "button.normal", mutationsAfter: 0 },
    ]);
  });

  it("flags multiple dead clicks independently", () => {
    const out = detectDeadClicks([
      click(100, "button.a"),
      click(5000, "button.b"),
      click(10_000, "button.c"),
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((d) => d.selector)).toEqual(["button.a", "button.b", "button.c"]);
  });
});
