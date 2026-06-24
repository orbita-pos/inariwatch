import { describe, it, expect } from "vitest";
import { extractReplayErrors } from "../helpers";

const err = (
  fingerprint: string,
  message: string,
  extra: Record<string, unknown> = {},
) => ({ _kind: "error", fingerprint, message, ...extra });

describe("extractReplayErrors", () => {
  it("returns [] for empty input", () => {
    expect(extractReplayErrors([])).toEqual([]);
  });

  it("ignores non-error events", () => {
    expect(extractReplayErrors([{ _kind: "console" }, { type: 3 }, null])).toEqual([]);
  });

  it("extracts a basic error", () => {
    const out = extractReplayErrors([err("abc", "TypeError: x is undefined")]);
    expect(out).toEqual([{ fingerprint: "abc", message: "TypeError: x is undefined" }]);
  });

  it("preserves source/line/col when present", () => {
    const out = extractReplayErrors([
      err("abc", "boom", { source: "https://app/page.js", line: 42, col: 7 }),
    ]);
    expect(out[0]).toMatchObject({ source: "https://app/page.js", line: 42, col: 7 });
  });

  it("dedups by fingerprint — first message wins", () => {
    const out = extractReplayErrors([
      err("dupe", "first message"),
      err("dupe", "second message — should be dropped"),
      err("other", "different fingerprint"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ fingerprint: "dupe", message: "first message" });
    expect(out[1]).toEqual({ fingerprint: "other", message: "different fingerprint" });
  });

  it("falls back to '(no message)' when message missing", () => {
    const out = extractReplayErrors([{ _kind: "error", fingerprint: "x" }]);
    expect(out[0].message).toBe("(no message)");
  });

  it("rejects events without a fingerprint string", () => {
    expect(extractReplayErrors([
      { _kind: "error", fingerprint: 42 },
      { _kind: "error", fingerprint: "" },
      { _kind: "error" },
    ])).toEqual([]);
  });

  it("caps long messages and sources", () => {
    const out = extractReplayErrors([
      err("x", "y".repeat(800), { source: "z".repeat(500) }),
    ]);
    expect(out[0].message.length).toBe(500);
    expect(out[0].source!.length).toBe(300);
  });

  it("caps fingerprint length to 128", () => {
    const out = extractReplayErrors([err("a".repeat(200), "msg")]);
    expect(out[0].fingerprint.length).toBe(128);
  });
});
