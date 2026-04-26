import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  FleetBloomClient,
  __resetContributionsForTesting,
  contributeFingerprint,
  deserialize,
  fleetBloomIntegration,
  has,
} from "../dist/index.js"

/**
 * Tests for @inariwatch/capture-fleet.
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Critical: SDK-side `has()` MUST return identical verdicts to the server's
 * `has()` for any given bloom byte sequence. We verify this by hand-rolling
 * the server's wire format here (we can't import the server module from
 * the SDK package without an unwanted dep cycle).
 */

const BLOOM_MAGIC = Buffer.from("IWBL", "utf8")

/** Mirror of the server's `add` + `serialize` for cross-compat tests. */
function buildServerBloom(items: string[], m = 16_000_000, k = 7): Buffer {
  const bits = Buffer.alloc(Math.ceil(m / 8))
  for (const item of items) {
    const positions = hashIndices(item, m, k)
    for (const pos of positions) {
      bits[pos >>> 3] |= 1 << (pos & 7)
    }
  }
  const header = Buffer.alloc(16)
  BLOOM_MAGIC.copy(header, 0)
  header[4] = 1
  header[5] = k
  header.writeUInt32LE(m, 8)
  header.writeUInt32LE(items.length, 12)
  return Buffer.concat([header, bits])
}

function hashIndices(item: string, m: number, k: number): number[] {
  const digest = createHash("sha256").update(item, "utf8").digest()
  const out: number[] = []
  for (let i = 0; i < k; i++) {
    let word: number
    if (i < 8) {
      word = digest.readUInt32LE(i * 4)
    } else {
      const more = createHash("sha256").update(item, "utf8").update(Buffer.from([i])).digest()
      word = more.readUInt32LE((i - 8) * 4)
    }
    out.push(word % m)
  }
  return out
}

// ── Wire-format cross-compat ──────────────────────────────────────────────

test("deserialize: round-trips a server-built bloom", () => {
  const items = ["fp-A", "fp-B", "fp-C"]
  const buf = buildServerBloom(items)
  const bloom = deserialize(buf)
  assert.equal(bloom.count, 3)
  assert.equal(bloom.k, 7)
  assert.equal(bloom.m, 16_000_000)
  for (const item of items) assert.equal(has(bloom, item), true, item)
  assert.equal(has(bloom, "absent"), false)
})

test("deserialize: rejects bad magic", () => {
  assert.throws(() => deserialize(Buffer.alloc(20)), /bad magic/)
})

test("has: byte-identical verdict to server (no client/server drift)", () => {
  const items = Array.from({ length: 50 }, (_, i) => `pattern-${i}`)
  const buf = buildServerBloom(items)
  const bloom = deserialize(buf)
  for (const item of items) assert.equal(has(bloom, item), true)
  // Probe never-inserted values
  for (let i = 1000; i < 1010; i++) {
    const probe = `pattern-${i}`
    // Some may FP at this scale but the test is real: at 50 items in a 16M
    // bit bloom the math says fps ≈ 0 within rounding.
    assert.equal(has(bloom, probe), false, probe)
  }
})

// ── FleetBloomClient ──────────────────────────────────────────────────────

function mockFetchOnce(buf: Buffer | null, status = 200, headers: Record<string, string> = {}) {
  // @ts-expect-error — patching global
  globalThis.fetch = async () =>
    new Response(buf, {
      status,
      headers: {
        "x-bloom-version": "abc1234567890def",
        "x-bloom-count": "10",
        "x-bloom-fpr": "1.00e-9",
        "x-bloom-built-at": "2026-04-24T00:00:00.000Z",
        ...headers,
      },
    })
}

test("FleetBloomClient.init: loads from server and serves hits", async () => {
  const items = ["fp-1", "fp-2", "fp-3"]
  mockFetchOnce(buildServerBloom(items))

  const client = new FleetBloomClient({ baseUrl: "http://test", initTimeoutMs: 100 })
  await client.init()
  client.close()

  for (const item of items) assert.equal(client.hasAnyoneElseHit(item), true)
  assert.equal(client.hasAnyoneElseHit("absent"), false)
  const meta = client.getMeta()
  assert.ok(meta)
  assert.equal(meta!.versionTag, "abc1234567890def")
})

test("FleetBloomClient.init: 503 means no bloom available — does not throw", async () => {
  mockFetchOnce(null, 503)
  const client = new FleetBloomClient({ baseUrl: "http://test", initTimeoutMs: 100 })
  await client.init()
  client.close()
  assert.equal(client.hasAnyoneElseHit("anything"), false)
  assert.equal(client.getMeta(), null)
})

test("FleetBloomClient.init: network error does not throw, leaves bloom empty", async () => {
  // @ts-expect-error
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED")
  }
  const client = new FleetBloomClient({ baseUrl: "http://test", initTimeoutMs: 100 })
  await client.init()
  client.close()
  assert.equal(client.hasAnyoneElseHit("anything"), false)
})

test("FleetBloomClient.refresh: 304 keeps the existing bloom", async () => {
  const items = ["fp-A"]
  mockFetchOnce(buildServerBloom(items))
  const client = new FleetBloomClient({ baseUrl: "http://test", initTimeoutMs: 100, refreshSeconds: 0 })
  await client.init()
  assert.equal(client.hasAnyoneElseHit("fp-A"), true)

  // Now mock a 304
  mockFetchOnce(null, 304)
  const refreshed = await client.refresh()
  client.close()
  assert.equal(refreshed, false)
  assert.equal(client.hasAnyoneElseHit("fp-A"), true)
})

// ── contributeFingerprint ─────────────────────────────────────────────────

test("contributeFingerprint: dedups within process", async () => {
  __resetContributionsForTesting()
  let calls = 0
  // @ts-expect-error
  globalThis.fetch = async () => {
    calls++
    return new Response(null, { status: 204 })
  }
  await contributeFingerprint("http://test", "fp-DEDUP")
  await contributeFingerprint("http://test", "fp-DEDUP")
  await contributeFingerprint("http://test", "fp-DEDUP")
  assert.equal(calls, 1)
})

test("contributeFingerprint: returns false on network error", async () => {
  __resetContributionsForTesting()
  // @ts-expect-error
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED")
  }
  const ok = await contributeFingerprint("http://test", "fp-NET-FAIL")
  assert.equal(ok, false)
})

// ── fleetBloomIntegration ─────────────────────────────────────────────────

test("integration: name + onBeforeSend present", () => {
  const integ = fleetBloomIntegration({ baseUrl: "http://test" })
  assert.equal(integ.name, "@inariwatch/capture-fleet")
  assert.equal(typeof integ.onBeforeSend, "function")
})

test("integration: attaches fleetMatch on event", async () => {
  const items = ["fp-INT"]
  mockFetchOnce(buildServerBloom(items))
  const integ = fleetBloomIntegration({ baseUrl: "http://test", initTimeoutMs: 100 })
  integ.setup({})
  // Wait briefly for fire-and-forget init to complete.
  await new Promise((r) => setTimeout(r, 50))

  const event = {
    fingerprint: "fp-INT",
    title: "x",
    body: "x",
    severity: "critical" as const,
    timestamp: "2026-04-24T00:00:00.000Z",
  }
  const out = await integ.onBeforeSend!(event)
  assert.notEqual(out, null)
  assert.equal(out!.fleetMatch?.bloomHit, true)
  assert.equal(out!.schemaVersion, "2.0")
})

test("integration: preserves an existing fleetMatch (don't clobber)", async () => {
  const integ = fleetBloomIntegration({ baseUrl: "http://test", initTimeoutMs: 50 })
  integ.setup({})
  const preset = { bloomHit: false, communityFixId: "external-fix" }
  const event = {
    fingerprint: "fp-X",
    title: "x",
    body: "x",
    severity: "critical" as const,
    timestamp: "2026-04-24T00:00:00.000Z",
    fleetMatch: preset,
  }
  const out = await integ.onBeforeSend!(event)
  assert.equal(out!.fleetMatch, preset)
})
