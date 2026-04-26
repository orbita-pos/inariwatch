import test from "node:test"
import assert from "node:assert/strict"
import { decode } from "../dist/msgpack-decoder.js"

/**
 * Property-based fuzzer for the msgpack decoder. Feeds it:
 *   (a) random byte sequences — must either decode or throw a typed error,
 *       never crash the host.
 *   (b) structured payloads that mimic forensics encoder output — must
 *       round-trip through a reference JS encoder.
 *
 * The decoder runs on untrusted bytes from the fork's shared-memory ring
 * buffer, so crash-resistance is a contract, not an optimization.
 */

const ITERATIONS = 2000

function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

function randBytes(rnd: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256)
  return out
}

test("random bytes never crash the host", () => {
  const rnd = prng(0xc0ffee)
  let decoded = 0
  let errored = 0
  for (let i = 0; i < ITERATIONS; i++) {
    const n = 1 + Math.floor(rnd() * 128)
    const buf = randBytes(rnd, n)
    try {
      decode(buf)
      decoded++
    } catch (e) {
      errored++
      // Only our own error messages are acceptable. Anything else means the
      // decoder leaked a host TypeError / RangeError.
      assert.ok(
        e instanceof Error && /msgpack/.test(e.message),
        `non-msgpack error on input ${[...buf].map((x) => x.toString(16)).join(" ")}: ${String(e)}`,
      )
    }
  }
  // Sanity: with uniform random we expect both paths to exercise.
  assert.ok(decoded > 0, "expected at least some random inputs to decode")
  assert.ok(errored > 0, "expected at least some random inputs to fail gracefully")
})

function encStr(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s))
  if (bytes.length < 32) return [0xa0 | bytes.length, ...bytes]
  if (bytes.length < 256) return [0xd9, bytes.length, ...bytes]
  const n = bytes.length
  return [0xda, (n >> 8) & 0xff, n & 0xff, ...bytes]
}

function encUint(n: number): number[] {
  if (n < 0x80) return [n]
  if (n < 0x100) return [0xcc, n]
  if (n < 0x10000) return [0xcd, (n >> 8) & 0xff, n & 0xff]
  return [0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function encInt(n: number): number[] {
  if (n >= 0) return encUint(n)
  if (n >= -32) return [0x100 + n]
  if (n >= -0x80) return [0xd0, 0x100 + n]
  if (n >= -0x8000) {
    const u = 0x10000 + n
    return [0xd1, (u >> 8) & 0xff, u & 0xff]
  }
  const u = 0x1_0000_0000 + n
  return [0xd2, (u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff]
}

function encArr(items: number[][]): number[] {
  const n = items.length
  const header =
    n < 16
      ? [0x90 | n]
      : [0xdc, (n >> 8) & 0xff, n & 0xff]
  return header.concat(...items)
}

function encMap(entries: Array<[string, number[]]>): number[] {
  const n = entries.length
  const header =
    n < 16
      ? [0x80 | n]
      : [0xde, (n >> 8) & 0xff, n & 0xff]
  return header.concat(...entries.flatMap(([k, v]) => [...encStr(k), ...v]))
}

test("round-trip: random structured payloads decode to expected JS", () => {
  const rnd = prng(0xbeef)
  for (let i = 0; i < 500; i++) {
    const n = Math.floor(rnd() * 6)
    const locals: Array<Record<string, unknown>> = []
    const bytes: number[] = []
    const entries: Array<[string, number[]]> = []
    for (let j = 0; j < n; j++) {
      const name = `v${j}`
      const num = Math.floor((rnd() - 0.5) * 1e6)
      locals.push({ name, value: num })
      entries.push([
        `slot${j}`,
        encMap([
          ["name", encStr(name)],
          ["value", encInt(num)],
        ]),
      ])
    }
    bytes.push(...encMap(entries))
    const got = decode(Uint8Array.from(bytes)) as Record<string, Record<string, unknown>>
    for (let j = 0; j < n; j++) {
      assert.equal(got[`slot${j}`]!.name, `v${j}`)
      assert.equal(got[`slot${j}`]!.value, locals[j]!.value)
    }
  }
})

test("pathological depth: 128-level nested array does not stack-overflow", () => {
  // 128 fixarr(1) headers followed by a single fixint 0.
  const buf = new Uint8Array(128 + 1)
  for (let i = 0; i < 128; i++) buf[i] = 0x91
  buf[128] = 0
  let cur: unknown = decode(buf)
  for (let i = 0; i < 128; i++) {
    assert.ok(Array.isArray(cur), `depth ${i} expected array`)
    cur = (cur as unknown[])[0]
  }
  assert.equal(cur, 0)
})

test("truncated headers produce typed errors, not crashes", () => {
  // str 8 header says 250 bytes, payload has 3.
  const buf = Uint8Array.from([0xd9, 0xfa, 0x41, 0x42, 0x43])
  assert.throws(() => decode(buf), /msgpack: truncated/)
})
