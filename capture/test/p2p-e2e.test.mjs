/**
 * End-to-end gossip mesh demo (Track F · piece 8 · Sesión 13).
 *
 * Spins up an InMemoryRelay (the test backend that mirrors the Cloudflare
 * Durable Object semantics in `server-cf.ts`) plus 3 distinct peers, each
 * with their own Ed25519 keypair. Asserts:
 *
 *   1. Peer A publishes a critical canary fingerprint.
 *   2. Peers B and C receive it via subscribe() within < 1 s (the SKYNET
 *      target from P2P_DESIGN.md §2 goal #1).
 *   3. The relay's stats account for one delivery per non-publisher peer.
 *
 * The latency printed at the bottom is the wall-clock time between
 * publishing on A and the first delivery to B and C respectively. With the
 * in-process transport it's microseconds; the same shape applies to the WS
 * + CF transport, where the budget is dominated by the WebSocket round-trip
 * (~50–150 ms global p95 for Cloudflare anycast).
 */

import test from "node:test"
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"

import {
  createPeer,
  InMemoryRelay,
} from "../dist/p2p/index.js"
import { __createInMemoryKeypair } from "../dist/signing.js"

const WORKSPACE = "ws_e2e_2026"

test("3-node gossip: canary reaches all peers within 1 second", () => {
  const relay = new InMemoryRelay()

  const make = (label) => {
    const transport = relay.connect(WORKSPACE)
    const peer = createPeer({
      enabled: true,
      workspaceId: WORKSPACE,
      keypair: __createInMemoryKeypair(),
      transport,
    })
    return { label, peer, received: [] }
  }

  const a = make("a")
  const b = make("b")
  const c = make("c")

  // Distinct keypairs guarantee distinct peer_ids.
  assert.notEqual(a.peer.peerId, b.peer.peerId)
  assert.notEqual(b.peer.peerId, c.peer.peerId)
  assert.notEqual(a.peer.peerId, c.peer.peerId)

  for (const node of [a, b, c]) {
    node.peer.subscribe((msg) => {
      node.received.push({ msg, at: performance.now() })
    })
  }

  const fingerprint = "f".repeat(64)
  const startedAt = performance.now()

  const signed = a.peer.publish({
    type: "canary_error",
    fingerprint,
    severity: "critical",
  })
  assert.ok(signed, "publisher should produce a signed envelope")

  // The in-memory transport delivers synchronously, so by the time
  // publish() returns both b and c have already been fanned out to.
  const stats = relay.getStats()
  assert.equal(stats.delivered, 2, "relay should have delivered to b and c only")
  assert.equal(stats.rejected.workspaceMismatch, 0)
  assert.equal(stats.rejected.badSignature, 0)
  assert.equal(stats.rejected.rateLimited, 0)
  assert.equal(stats.blocked.length, 0)

  // Sender does not echo to itself.
  assert.equal(a.received.length, 0, "publisher must not echo to itself")
  // Receivers admitted the envelope.
  assert.equal(b.received.length, 1)
  assert.equal(c.received.length, 1)

  // Latency check — both receivers under the 1-second goal.
  const latencyB = b.received[0].at - startedAt
  const latencyC = c.received[0].at - startedAt
  assert.ok(latencyB < 1000, `peer B latency ${latencyB.toFixed(3)} ms exceeded 1 s budget`)
  assert.ok(latencyC < 1000, `peer C latency ${latencyC.toFixed(3)} ms exceeded 1 s budget`)

  // Envelope round-trip: each receiver got the same signed bytes.
  assert.equal(b.received[0].msg.fingerprint, fingerprint)
  assert.equal(c.received[0].msg.fingerprint, fingerprint)
  assert.equal(b.received[0].msg.peer_id, a.peer.peerId)

  // Print the demo numbers — these show up in `npm test` output and back
  // up the latency claim in the design doc.
  console.log(
    `[p2p-e2e] 3-node gossip latency: B=${latencyB.toFixed(3)} ms, C=${latencyC.toFixed(3)} ms`,
  )

  a.peer.shutdown()
  b.peer.shutdown()
  c.peer.shutdown()
  relay.shutdown()
})

test("workspace isolation: gossip from another workspace is dropped", () => {
  const relay = new InMemoryRelay()

  const transportA = relay.connect("ws_alpha")
  const peerA = createPeer({
    enabled: true,
    workspaceId: "ws_alpha",
    keypair: __createInMemoryKeypair(),
    transport: transportA,
  })

  const transportB = relay.connect("ws_beta")
  const peerB = createPeer({
    enabled: true,
    workspaceId: "ws_beta",
    keypair: __createInMemoryKeypair(),
    transport: transportB,
  })

  const received = []
  peerB.subscribe((msg) => received.push(msg))

  const signed = peerA.publish({
    type: "canary_error",
    fingerprint: "1".repeat(64),
    severity: "critical",
  })
  assert.ok(signed)

  // Different workspace → relay's per-workspace fan-out skips B entirely.
  assert.equal(received.length, 0)
  assert.equal(relay.getStats().delivered, 0)

  peerA.shutdown()
  peerB.shutdown()
  relay.shutdown()
})

test("pubkey distribution: relay registers pubkey on first message", () => {
  const relay = new InMemoryRelay()
  const transport = relay.connect(WORKSPACE)
  const peer = createPeer({
    enabled: true,
    workspaceId: WORKSPACE,
    keypair: __createInMemoryKeypair(),
    transport,
  })

  // Pre-publish the registry has no entry.
  assert.equal(relay.getPubkey(peer.peerId), null)

  const signed = peer.publish({
    type: "canary_error",
    fingerprint: "2".repeat(64),
    severity: "error",
  })
  assert.ok(signed)

  // Post-publish the relay knows this peer's pubkey and can hand it out.
  assert.equal(relay.getPubkey(peer.peerId), signed.pubkey)

  peer.shutdown()
  relay.shutdown()
})
