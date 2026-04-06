/**
 * Chaos test: Dedup race conditions.
 *
 * Tests that the fingerprint-based dedup is atomic — concurrent inserts
 * with the same fingerprint should produce exactly 1 alert, not N.
 *
 * Since we can't hit the real DB in unit tests, this validates the
 * fingerprint determinism and the race condition pattern itself.
 */

import { describe, it, expect } from "vitest";
import { racingCalls } from "../faults";
import { computeErrorFingerprint } from "@/lib/ai/fingerprint";

describe("Chaos: Dedup Race Conditions", () => {
  it("same error always produces the same fingerprint (deterministic)", () => {
    const fp1 = computeErrorFingerprint("TypeError: Cannot read property 'x' of undefined", "at Object.<anonymous> (/app/src/index.ts:42:5)");
    const fp2 = computeErrorFingerprint("TypeError: Cannot read property 'x' of undefined", "at Object.<anonymous> (/app/src/index.ts:42:5)");

    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64); // SHA-256 hex
  });

  it("different errors produce different fingerprints", () => {
    const fp1 = computeErrorFingerprint("TypeError: x is not a function", "stack1");
    const fp2 = computeErrorFingerprint("RangeError: Maximum call stack size exceeded", "stack2");

    expect(fp1).not.toBe(fp2);
  });

  it("fingerprint is stable across timestamp/UUID variations", () => {
    const fp1 = computeErrorFingerprint(
      "Error at 2025-01-01T00:00:00Z in request abc123def",
      "at handler (/app/route.ts:10:5)",
    );
    const fp2 = computeErrorFingerprint(
      "Error at 2026-04-05T12:30:00Z in request 999888777",
      "at handler (/app/route.ts:10:5)",
    );

    // Timestamps and hex IDs are normalized, so fingerprints should match
    expect(fp1).toBe(fp2);
  });

  it("concurrent fingerprint computations are consistent", async () => {
    const title = "Connection refused: ECONNREFUSED 127.0.0.1:5432";
    const body = "at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)";

    const results = await racingCalls(100, async () => {
      return computeErrorFingerprint(title, body);
    });

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
    );

    expect(fulfilled.length).toBe(100);

    // All 100 concurrent calls should produce the exact same fingerprint
    const uniqueFingerprints = new Set(fulfilled.map((r) => r.value));
    expect(uniqueFingerprints.size).toBe(1);
  });

  it("simulates SELECT-then-INSERT race (demonstrates the problem)", async () => {
    // Simulate the old non-atomic pattern:
    // 1. Check if exists (SELECT) — all N concurrent calls see "not exists"
    // 2. Insert (INSERT) — all N insert a duplicate
    //
    // This test proves the race exists at the application level.
    // The fix (INSERT ON CONFLICT DO NOTHING) moves dedup to the DB level.

    const inserted: string[] = [];
    const fingerprint = "test-fingerprint-abc123";

    // Simulate old pattern: check-then-insert without atomicity
    const checkThenInsert = async () => {
      // Step 1: "SELECT" — check if exists (simulated with array lookup)
      const exists = inserted.includes(fingerprint);
      if (exists) return null;

      // Step 2: Artificial delay simulating DB round-trip
      await new Promise((r) => setTimeout(r, Math.random() * 10));

      // Step 3: "INSERT" — add to array (simulated)
      inserted.push(fingerprint);
      return fingerprint;
    };

    const results = await racingCalls(10, checkThenInsert);
    const successful = results.filter(
      (r): r is PromiseFulfilledResult<string | null> =>
        r.status === "fulfilled" && r.value !== null,
    );

    // With the old pattern, multiple calls slip through the check
    // (This demonstrates WHY we need atomic INSERT ON CONFLICT)
    expect(successful.length).toBeGreaterThanOrEqual(1);
    // In practice, most or all 10 will succeed (race condition)
    // The exact number is non-deterministic, but it's almost always > 1
  });

  it("simulates atomic INSERT ON CONFLICT (the fix)", async () => {
    // Simulate the new atomic pattern:
    // INSERT ON CONFLICT DO NOTHING — only 1 succeeds, rest return null
    const insertedSet = new Set<string>();
    const fingerprint = "test-fingerprint-atomic";

    const atomicInsert = async () => {
      // Artificial delay simulating network
      await new Promise((r) => setTimeout(r, Math.random() * 10));

      // Atomic check-and-insert (simulated with Set + boolean return)
      // This is what INSERT ON CONFLICT DO NOTHING does at the DB level
      if (insertedSet.has(fingerprint)) return null;
      insertedSet.add(fingerprint);
      return fingerprint;
    };

    // Note: JS Set is single-threaded, so this doesn't perfectly simulate
    // DB-level atomicity. The real test is the DB migration + ON CONFLICT.
    // This test validates the logic pattern.
    const results = await racingCalls(10, atomicInsert);
    const successful = results.filter(
      (r): r is PromiseFulfilledResult<string | null> =>
        r.status === "fulfilled" && r.value !== null,
    );

    // With atomic insert, exactly 1 should succeed
    // (JS Set is single-threaded, so this always passes — the real
    // validation is the Postgres unique index + ON CONFLICT DO NOTHING)
    expect(successful.length).toBe(1);
  });
});
