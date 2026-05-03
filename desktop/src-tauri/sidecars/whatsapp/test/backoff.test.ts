// v0.3 S5 — Backoff progression mirrors the Rust-side pattern.
// Same window assertions as `desktop/src-tauri/src/relay_client.rs`'s
// `backoff_progresses_exponentially` test.

import { describe, expect, it } from "vitest";

import { Backoff } from "../src/connection.js";

describe("Backoff", () => {
  it("progresses 1s → 2s → 4s → 8s → 16s → 30s with ±20% jitter", () => {
    const b = new Backoff(10);
    const xs = Array.from({ length: 7 }, () => b.next() / 1000);
    expect(xs[0]).toBeLessThan(1.5);
    expect(xs[1]).toBeGreaterThanOrEqual(1.5);
    expect(xs[1]).toBeLessThan(3.0);
    expect(xs[2]).toBeGreaterThanOrEqual(3.0);
    expect(xs[2]).toBeLessThan(5.5);
    expect(xs[3]).toBeGreaterThanOrEqual(6.0);
    expect(xs[3]).toBeLessThan(10.5);
    expect(xs[4]).toBeGreaterThanOrEqual(12.0);
    expect(xs[4]).toBeLessThan(20.5);
    expect(xs[5]).toBeGreaterThanOrEqual(24.0);
    expect(xs[5]).toBeLessThan(36.5);
    expect(xs[6]).toBeGreaterThanOrEqual(24.0);
    expect(xs[6]).toBeLessThan(36.5);
  });

  it("reset() starts the counter over", () => {
    const b = new Backoff(5);
    for (let i = 0; i < 5; i += 1) b.next();
    b.reset();
    expect(b.attempts()).toBe(0);
    expect(b.next() / 1000).toBeLessThan(1.5);
  });

  it("exhausted() flips after maxAttempts calls", () => {
    const b = new Backoff(3);
    b.next();
    b.next();
    expect(b.exhausted()).toBe(false);
    b.next();
    expect(b.exhausted()).toBe(true);
  });
});
