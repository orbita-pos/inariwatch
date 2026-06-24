/**
 * Stub tests for the P2P gossip mesh client (Track F · piece 8 · Sesión 12).
 *
 * Sesión 13 will swap in real transport tests against a wrangler-hosted
 * Cloudflare Durable Object. For now these confirm the contract exposed by
 * `src/p2p/client.ts`:
 *   - opt-in toggle (no-op when disabled, both at module scope and at call sites)
 *   - canonicalize() is deterministic and sorts keys (cross-language signing parity)
 *   - peerPublish + peerAdmit roundtrip (sign-then-verify on the same install)
 *   - dedup window: 4th identical message inside 10s is dropped
 *
 * Run from `capture/`:
 *   npm test     # builds capture, then runs this file
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  peerEnable,
  peerEnabled,
  peerPublish,
  peerSubscribe,
  peerAdmit,
  peerShutdown,
  canonicalize,
  __resetPeerForTesting,
} from "../dist/p2p/index.js"
import {
  getOrCreateKeypair,
  __resetSigningCacheForTesting,
} from "../dist/signing.js"

const WORKSPACE = "ws_test_2026"

// Each test gets its own scratch keypair dir so the suite doesn't touch
// `~/.inariwatch/` and tests don't leak state into each other.
function withScratchKeypair(fn) {
  const dir = mkdtempSync(join(tmpdir(), "iw-p2p-"))
  const keyPath = join(dir, "keypair.json")
  __resetSigningCacheForTesting()
  // Force the cache to land at our scratch path.
  getOrCreateKeypair({ keyPath })
  try {
    fn()
  } finally {
    __resetPeerForTesting()
    __resetSigningCacheForTesting()
    rmSync(dir, { recursive: true, force: true })
  }
}

test("peerEnabled defaults to false (opt-in)", () => {
  __resetPeerForTesting()
  assert.equal(peerEnabled(), false)
  // peerPublish on a non-initialized runtime is a safe no-op.
  const result = peerPublish({ type: "canary_error", fingerprint: "x", severity: "error" })
  assert.equal(result, null)
})

test("peerEnable({ enabled: false }) keeps the client off", () => {
  __resetPeerForTesting()
  peerEnable({ enabled: false, workspaceId: WORKSPACE })
  assert.equal(peerEnabled(), false)
  assert.equal(
    peerPublish({ type: "canary_error", fingerprint: "x", severity: "error" }),
    null,
  )
  peerShutdown()
})

test("canonicalize sorts keys deterministically", () => {
  const a = canonicalize({ b: 2, a: 1, c: 3 })
  const b = canonicalize({ a: 1, c: 3, b: 2 })
  assert.equal(a, b)
  assert.equal(a, '{"a":1,"b":2,"c":3}')
})

test("peerPublish signs an envelope that peerAdmit can verify", () => {
  withScratchKeypair(() => {
    peerEnable({ enabled: true, workspaceId: WORKSPACE })
    const received = []
    peerSubscribe((msg) => received.push(msg))

    const fingerprint = "a".repeat(64)
    const signed = peerPublish({
      type: "canary_error",
      fingerprint,
      severity: "critical",
      count: 1,
    })
    assert.ok(signed, "peerPublish should sign and return the envelope")
    assert.equal(signed.v, 1)
    assert.equal(signed.workspace_id, WORKSPACE)
    assert.equal(signed.fingerprint, fingerprint)
    assert.equal(signed.sig.length, 128)
    assert.equal(signed.pubkey.length, 64)

    // Round-trip the same envelope through the receiver path.
    const accepted = peerAdmit(signed)
    assert.equal(accepted, true)
    assert.equal(received.length, 1)
    assert.equal(received[0].fingerprint, fingerprint)

    peerShutdown()
  })
})

test("peerAdmit drops messages from a different workspace", () => {
  withScratchKeypair(() => {
    peerEnable({ enabled: true, workspaceId: WORKSPACE })
    const signed = peerPublish({
      type: "canary_error",
      fingerprint: "b".repeat(64),
      severity: "error",
    })
    assert.ok(signed)

    // Forge a workspace mismatch — the signature is now invalid too, but the
    // workspace check is the cheap defense-in-depth gate that runs first.
    const tampered = { ...signed, workspace_id: "ws_other" }
    assert.equal(peerAdmit(tampered), false)
    peerShutdown()
  })
})

test("dedup window drops the 4th identical message inside 10s", () => {
  withScratchKeypair(() => {
    peerEnable({ enabled: true, workspaceId: WORKSPACE })
    const fingerprint = "c".repeat(64)
    const start = Date.now()

    // First three are admitted, fourth is dropped — this matches the design
    // doc rule "drop after the 3rd in the window".
    const sigs = [0, 1, 2, 3].map((i) =>
      peerPublish({
        type: "canary_error",
        fingerprint,
        severity: "warning",
        count: i + 1,
        nowMs: start + i * 100,
      }),
    )
    sigs.forEach((s) => assert.ok(s, "all 4 publishes must produce a signed envelope"))

    const results = sigs.map((s, i) => peerAdmit(s, { nowMs: start + i * 100 + 1 }))
    assert.deepEqual(results, [true, true, true, false])
    peerShutdown()
  })
})
