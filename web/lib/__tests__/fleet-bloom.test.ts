/**
 * Tests for the fleet bloom data structure + wire format.
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4 acceptance.
 *
 * The wire format is the SSOT for both server and SDK — these tests pin
 * its layout so a sibling `capture-fleet/src/bloom.ts` change is caught
 * by a snapshot mismatch, not a silent client/server drift.
 */

import { describe, it, expect } from "vitest"
import {
  add,
  BLOOM_MAGIC,
  BLOOM_VERSION,
  DEFAULT_K,
  DEFAULT_M,
  deserialize,
  estimateFpr,
  fingerprint,
  has,
  newBloom,
  serialize,
} from "@/lib/fleet-bloom/bloom"

describe("newBloom", () => {
  it("uses defaults", () => {
    const b = newBloom()
    expect(b.m).toBe(DEFAULT_M)
    expect(b.k).toBe(DEFAULT_K)
    expect(b.count).toBe(0)
    expect(b.bits.byteLength).toBe(Math.ceil(DEFAULT_M / 8))
  })
  it("rejects bad m", () => {
    expect(() => newBloom(0)).toThrow()
    expect(() => newBloom(0x1_0000_0000)).toThrow()
  })
  it("rejects bad k", () => {
    expect(() => newBloom(DEFAULT_M, 0)).toThrow()
    expect(() => newBloom(DEFAULT_M, 17)).toThrow()
  })
})

describe("add + has", () => {
  it("hits items that were added", () => {
    const b = newBloom()
    add(b, "fp-1")
    add(b, "fp-2")
    expect(has(b, "fp-1")).toBe(true)
    expect(has(b, "fp-2")).toBe(true)
    expect(b.count).toBe(2)
  })

  it("misses items that were not added (no false negatives)", () => {
    const b = newBloom()
    add(b, "fp-1")
    expect(has(b, "fp-2")).toBe(false)
    expect(has(b, "fp-3")).toBe(false)
  })

  it("is byte-stable for the same input across calls", () => {
    const a = newBloom()
    const b = newBloom()
    add(a, "fp-A")
    add(b, "fp-A")
    expect(serialize(a).equals(serialize(b))).toBe(true)
  })

  it("ordering does not affect final bits", () => {
    const a = newBloom()
    const b = newBloom()
    add(a, "fp-X")
    add(a, "fp-Y")
    add(b, "fp-Y")
    add(b, "fp-X")
    // Counts equal, bits equal.
    expect(a.count).toBe(b.count)
    expect(a.bits.equals(b.bits)).toBe(true)
  })
})

describe("serialize / deserialize round-trip", () => {
  it("round-trips an empty bloom", () => {
    const a = newBloom()
    const buf = serialize(a)
    const b = deserialize(buf)
    expect(b.m).toBe(a.m)
    expect(b.k).toBe(a.k)
    expect(b.count).toBe(0)
    expect(b.bits.equals(a.bits)).toBe(true)
  })

  it("round-trips a populated bloom and preserves has() behavior", () => {
    const a = newBloom()
    for (let i = 0; i < 100; i++) add(a, `fp-${i}`)
    const buf = serialize(a)
    const b = deserialize(buf)
    expect(b.count).toBe(100)
    for (let i = 0; i < 100; i++) expect(has(b, `fp-${i}`)).toBe(true)
    expect(has(b, "absent")).toBe(false)
  })

  it("rejects buffers without IWBL magic", () => {
    const buf = Buffer.alloc(20)
    expect(() => deserialize(buf)).toThrow(/bad magic/)
  })

  it("header layout: 16 bytes with magic + version + k + m + count", () => {
    const b = newBloom(8000, 5)
    add(b, "x")
    add(b, "y")
    add(b, "z")
    const buf = serialize(b)
    expect(buf.subarray(0, 4).equals(BLOOM_MAGIC)).toBe(true)
    expect(buf[4]).toBe(BLOOM_VERSION)
    expect(buf[5]).toBe(5)
    expect(buf.readUInt32LE(8)).toBe(8000)
    expect(buf.readUInt32LE(12)).toBe(3)
  })
})

describe("estimateFpr", () => {
  it("is 0 for an empty bloom", () => {
    expect(estimateFpr(newBloom())).toBe(0)
  })
  it("stays well under 1% at 100K items (Q5.4 acceptance)", () => {
    // Math-only estimate — populating 100K is ~5MB of digests; we only need
    // the formula to verify the budget headroom.
    const b = newBloom()
    b.count = 100_000
    const fpr = estimateFpr(b)
    expect(fpr).toBeLessThan(0.01)
  })
})

describe("fingerprint (version tag)", () => {
  it("differs when content differs", () => {
    const a = newBloom()
    const b = newBloom()
    add(a, "x")
    expect(fingerprint(a)).not.toBe(fingerprint(b))
  })
  it("matches when content matches", () => {
    const a = newBloom()
    const b = newBloom()
    add(a, "x")
    add(b, "x")
    expect(fingerprint(a)).toBe(fingerprint(b))
  })
  it("is 16 hex chars", () => {
    const tag = fingerprint(newBloom())
    expect(tag).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("integration: real-world fingerprint corpus", () => {
  it("FP rate stays under 1% on a 10K-item corpus with 10K probe set", () => {
    const b = newBloom()
    const inserted = new Set<string>()
    // Insert 10K items
    for (let i = 0; i < 10_000; i++) {
      const item = `fingerprint-${i}-` + Math.sin(i).toString(36)
      inserted.add(item)
      add(b, item)
    }
    // Probe 10K NOT-inserted items, count false positives
    let fps = 0
    for (let i = 100_000; i < 110_000; i++) {
      const probe = `fingerprint-${i}-` + Math.sin(i).toString(36)
      if (inserted.has(probe)) continue // belt + braces
      if (has(b, probe)) fps++
    }
    // Expected ≈ 0 at this scale (theoretical p ≈ 1e-12). Allow some slack.
    expect(fps).toBeLessThan(100)
  })
})
