import { describe, it, expect } from "vitest";
import { findPrevEventIndex, findNextEventIndex } from "./frame-scrub";

const TS = [100, 250, 500, 1200, 3000, 5000];

describe("findPrevEventIndex", () => {
  it("returns -1 for empty input", () => {
    expect(findPrevEventIndex([], 1000)).toBe(-1);
  });

  it("returns -1 when before the first event", () => {
    expect(findPrevEventIndex(TS, 50)).toBe(-1);
    expect(findPrevEventIndex(TS, 100)).toBe(-1); // exactly on boundary → still none "before"
  });

  it("returns the largest index whose timestamp is < currentMs", () => {
    expect(findPrevEventIndex(TS, 251)).toBe(1); // 250
    expect(findPrevEventIndex(TS, 1500)).toBe(3); // 1200
    expect(findPrevEventIndex(TS, 5000)).toBe(4); // 3000 (epsilon prevents stick at 5000)
    expect(findPrevEventIndex(TS, 99999)).toBe(5); // 5000
  });

  it("does not get stuck on the active boundary", () => {
    // Standing exactly on TS[2] = 500 → repeated tap should return 250 then 100
    expect(findPrevEventIndex(TS, 500)).toBe(1); // 250
    expect(findPrevEventIndex(TS, 250)).toBe(0); // 100
  });
});

describe("findNextEventIndex", () => {
  it("returns -1 for empty input", () => {
    expect(findNextEventIndex([], 1000)).toBe(-1);
  });

  it("returns -1 when past the last event", () => {
    expect(findNextEventIndex(TS, 5000)).toBe(-1); // exactly on boundary → no next
    expect(findNextEventIndex(TS, 99999)).toBe(-1);
  });

  it("returns the smallest index whose timestamp is > currentMs", () => {
    expect(findNextEventIndex(TS, 50)).toBe(0); // 100
    expect(findNextEventIndex(TS, 251)).toBe(2); // 500
    expect(findNextEventIndex(TS, 1200)).toBe(4); // 3000
  });

  it("does not get stuck on the active boundary", () => {
    expect(findNextEventIndex(TS, 100)).toBe(1); // 250
    expect(findNextEventIndex(TS, 250)).toBe(2); // 500
  });

  it("epsilon: standing 1ms after a boundary still advances", () => {
    expect(findNextEventIndex(TS, 101)).toBe(1); // 250
  });
});
