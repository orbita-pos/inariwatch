/**
 * Fleet bloom filter — pure data structure, byte-format SSOT.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Wire format (must stay byte-identical to capture-fleet/src/bloom.ts):
 *   header (16 bytes):
 *     [0..3]   "IWBL"  — magic
 *     [4]      version (u8) — currently 1
 *     [5]      k       (u8) — hash count, default 7
 *     [6..7]   reserved
 *     [8..11]  m       (u32 LE) — bit count, default 16_000_000
 *     [12..15] count   (u32 LE) — number of items inserted
 *   body:
 *     ceil(m / 8) bytes — bit array
 *
 * Hashing: SHA-256(fingerprint) sliced into k uint32 LE, each `% m`.
 * Why 7 hashes: theoretical optimum k for fp ≈ 0.5% at n/m ≈ 0.07.
 *
 * Math (n = unique items):
 *   p = (1 - exp(-k * n / m))^k
 *   k=7, m=16M:
 *     n=100K → p ≈ 8.3e-10  (~zero)
 *     n=1M   → p ≈ 7.6e-4   (~0.08%)
 *     n=10M  → p ≈ 0.10     (too many — rebuild + raise m)
 *
 * The bloom is content-addressed by SHA-256(buffer) — clients ETag against it.
 */

import { createHash } from "node:crypto"

export const BLOOM_MAGIC = Buffer.from("IWBL", "utf8")
export const BLOOM_VERSION = 1
export const DEFAULT_M = 16_000_000
export const DEFAULT_K = 7
const HEADER_LEN = 16

export interface BloomFilter {
  m: number
  k: number
  count: number
  bits: Buffer
}

export function newBloom(m: number = DEFAULT_M, k: number = DEFAULT_K): BloomFilter {
  if (m <= 0 || m > 0xffff_ffff) throw new Error(`bloom: m out of range: ${m}`)
  if (k < 1 || k > 16) throw new Error(`bloom: k out of range: ${k}`)
  return { m, k, count: 0, bits: Buffer.alloc(Math.ceil(m / 8)) }
}

/** Hash a single item into k bit positions. */
function hashIndices(item: string, m: number, k: number): number[] {
  const digest = createHash("sha256").update(item, "utf8").digest()
  const out: number[] = []
  // SHA-256 = 32 bytes = 8 u32 LE. We need up to 16 hashes; double-hash if k > 8.
  for (let i = 0; i < k; i++) {
    let word: number
    if (i < 8) {
      word = digest.readUInt32LE(i * 4)
    } else {
      // Double-hash trick: H(item || i)
      const more = createHash("sha256").update(item, "utf8").update(Buffer.from([i])).digest()
      word = more.readUInt32LE((i - 8) * 4)
    }
    out.push(word % m)
  }
  return out
}

export function add(bloom: BloomFilter, item: string): void {
  const positions = hashIndices(item, bloom.m, bloom.k)
  for (const pos of positions) {
    const byte = pos >>> 3
    const bit = pos & 7
    bloom.bits[byte] |= 1 << bit
  }
  bloom.count++
}

export function has(bloom: BloomFilter, item: string): boolean {
  const positions = hashIndices(item, bloom.m, bloom.k)
  for (const pos of positions) {
    const byte = pos >>> 3
    const bit = pos & 7
    if ((bloom.bits[byte] & (1 << bit)) === 0) return false
  }
  return true
}

export function serialize(bloom: BloomFilter): Buffer {
  const header = Buffer.alloc(HEADER_LEN)
  BLOOM_MAGIC.copy(header, 0)
  header[4] = BLOOM_VERSION
  header[5] = bloom.k
  // [6..7] reserved (zero)
  header.writeUInt32LE(bloom.m, 8)
  header.writeUInt32LE(bloom.count, 12)
  return Buffer.concat([header, bloom.bits])
}

export function deserialize(buf: Buffer): BloomFilter {
  if (buf.length < HEADER_LEN) throw new Error("bloom: buffer too short for header")
  if (!buf.subarray(0, 4).equals(BLOOM_MAGIC)) throw new Error("bloom: bad magic")
  const version = buf[4]
  if (version !== BLOOM_VERSION) {
    throw new Error(`bloom: unsupported version ${version}`)
  }
  const k = buf[5]!
  const m = buf.readUInt32LE(8)
  const count = buf.readUInt32LE(12)
  const expectedBytes = Math.ceil(m / 8)
  const bits = Buffer.alloc(expectedBytes)
  buf.copy(bits, 0, HEADER_LEN, HEADER_LEN + expectedBytes)
  return { m, k, count, bits }
}

/** Estimated false-positive rate for the current load. */
export function estimateFpr(bloom: BloomFilter): number {
  if (bloom.count === 0) return 0
  return Math.pow(1 - Math.exp((-bloom.k * bloom.count) / bloom.m), bloom.k)
}

/** SHA-256 of the serialized bloom — used as the ETag / version tag. */
export function fingerprint(bloom: BloomFilter): string {
  return createHash("sha256").update(serialize(bloom)).digest("hex").slice(0, 16)
}
