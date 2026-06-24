import { describe, it, expect } from "vitest";
import { summarizeChains } from "../helpers";

describe("summarizeChains", () => {
  it("returns empty for null/undefined/non-object", () => {
    expect(summarizeChains(null)).toEqual([]);
    expect(summarizeChains(undefined)).toEqual([]);
    expect(summarizeChains("string")).toEqual([]);
    expect(summarizeChains(42)).toEqual([]);
  });

  it("returns empty when the payload is a legacy Chapter[] (Phase 1)", () => {
    const legacy = [{ ts: 100, title: "Open page" }];
    expect(summarizeChains(legacy)).toEqual([]);
  });

  it("returns empty when chains is missing or non-array", () => {
    expect(summarizeChains({ chapters: [] })).toEqual([]);
    expect(summarizeChains({ chains: "not an array" })).toEqual([]);
  });

  it("normalizes a single chain to {errorFingerprint, steps}", () => {
    const input = {
      chapters: [{ ts: 0, title: "Start" }],
      chains: [
        {
          errorFingerprint: "fp-1",
          links: [
            { role: "user_action", tsRelative: 1000, summary: "click button.submit" },
            { role: "http_cause", tsRelative: 1100, summary: "POST /api/users → 500" },
            { role: "error", tsRelative: 1200, summary: "DB timeout" },
          ],
        },
      ],
    };
    expect(summarizeChains(input)).toEqual([
      {
        errorFingerprint: "fp-1",
        steps: [
          "user_action @ 1000ms: click button.submit",
          "http_cause @ 1100ms: POST /api/users → 500",
          "error @ 1200ms: DB timeout",
        ],
      },
    ]);
  });

  it("drops links missing role or summary", () => {
    const input = {
      chains: [
        {
          errorFingerprint: "fp",
          links: [
            { role: "user_action", tsRelative: 0, summary: "click" },
            { role: "http_cause" /* no summary */ },
            { tsRelative: 200, summary: "orphan" /* no role */ },
            null,
            "string",
          ],
        },
      ],
    };
    const out = summarizeChains(input);
    expect(out).toHaveLength(1);
    expect(out[0].steps).toEqual(["user_action @ 0ms: click"]);
  });

  it("skips chains missing errorFingerprint or links", () => {
    const input = {
      chains: [
        { errorFingerprint: "valid", links: [{ role: "error", tsRelative: 0, summary: "x" }] },
        { links: [{ role: "error", tsRelative: 0, summary: "y" }] }, // no fingerprint
        { errorFingerprint: "nolinks" }, // no links
        null,
      ],
    };
    const out = summarizeChains(input);
    expect(out).toHaveLength(1);
    expect(out[0].errorFingerprint).toBe("valid");
  });

  it("preserves multiple chains", () => {
    const input = {
      chains: [
        { errorFingerprint: "a", links: [{ role: "error", tsRelative: 100, summary: "A" }] },
        { errorFingerprint: "b", links: [{ role: "error", tsRelative: 200, summary: "B" }] },
      ],
    };
    const out = summarizeChains(input);
    expect(out.map((c) => c.errorFingerprint)).toEqual(["a", "b"]);
  });
});
