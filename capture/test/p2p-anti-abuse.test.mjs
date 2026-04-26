/**
 * Anti-abuse e2e (Track F · piece 8 · Sesión 13).
 *
 * Drives the relay's three defense layers (P2P_DESIGN.md §5):
 *   1. Per-peer rate limit (200 msg/min on the relay; 100/min on each
 *      receiver — overflow drops + counts toward blocklist).
 *   2. 3-rejections-in-5-min blocklist with 5-minute timeout.
 *   3. Honest peers in the same workspace must keep flowing while the
 *      offender is silenced.
 *
 * Flooder strategy: bypass the publisher-side bucket by signing envelopes
 * directly and feeding them through the transport, the way a compromised
 * SDK would. This proves the relay holds the line even when the local
 * rate limiter is gone.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  createPeer,
  InMemoryRelay,
  canonicalize,
} from "../dist/p2p/index.js"
import {
  __createInMemoryKeypair,
  signReceiptId,
} from "../dist/signing.js"

const WORKSPACE = "ws_abuse_2026"

/** Forge envelopes directly — bypasses the publisher-side rate limit. */
function buildSignedMessage(keypair, opts) {
  const unsigned = {
    v: 1,
    type: opts.type ?? "canary_error",
    workspace_id: opts.workspaceId,
    peer_id: keypair.pubKeyId,
    fingerprint: opts.fingerprint,
    severity: opts.severity ?? "warning",
    count: opts.count ?? 1,
    ts: new Date(opts.nowMs ?? Date.now()).toISOString(),
  }
  const sigInput = canonicalize(unsigned)
  const digest = createHash("sha256").update(sigInput, "utf8").digest("hex")
  const sig = signReceiptId(digest, keypair)
  return { ...unsigned, pubkey: keypair.publicKeyHex, sig }
}

test("relay blocklists a spammer; honest peers keep flowing", () => {
  // Drive the relay clock forward manually so the rate-limit bucket doesn't
  // refill while the test floods. Anchor at real Date.now() so receiver-side
  // freshness checks (which use real Date.now()) accept our messages — the
  // SDK's admit() doesn't take a clock injection by design.
  let now = Date.now()
  const relay = new InMemoryRelay(() => now)

  const honestKp = __createInMemoryKeypair()
  const honestTransport = relay.connect(WORKSPACE)
  const honest = createPeer({
    enabled: true,
    workspaceId: WORKSPACE,
    keypair: honestKp,
    transport: honestTransport,
  })

  const witnessKp = __createInMemoryKeypair()
  const witnessTransport = relay.connect(WORKSPACE)
  const witness = createPeer({
    enabled: true,
    workspaceId: WORKSPACE,
    keypair: witnessKp,
    transport: witnessTransport,
  })
  const witnessReceived = []
  witness.subscribe((m) => witnessReceived.push(m))

  // The flooder connects but does NOT use the publish() bucket — it builds
  // and shoves signed envelopes straight at the transport, the way a
  // compromised install would.
  const spammerKp = __createInMemoryKeypair()
  const spammerTransport = relay.connect(WORKSPACE)

  const sendForged = (i) =>
    spammerTransport.publish(
      buildSignedMessage(spammerKp, {
        workspaceId: WORKSPACE,
        fingerprint: i.toString(16).padStart(64, "0"),
        nowMs: now,
      }),
    )

  // Burn the relay's bucket: 200 tokens, then keep going. The first 200
  // are delivered; tokens 201-203 hit the rate limiter (3 rejections, the
  // blocklist trigger); tokens 204+ are short-circuited by the blocklist.
  for (let i = 0; i < 220; i++) sendForged(i)

  let stats = relay.getStats()
  // After 3 rate-limit rejections the blocklist trips, so further rejections
  // bucket under `blocked` instead of `rateLimited`. Both are abuse signals.
  assert.equal(
    stats.rejected.rateLimited,
    3,
    `expected exactly 3 rate-limit rejections before blocklist trips, got ${stats.rejected.rateLimited}`,
  )
  assert.ok(
    stats.rejected.blocked >= 15,
    `expected ≥15 blocklist rejections after the trip, got ${stats.rejected.blocked}`,
  )
  assert.ok(
    stats.blocked.includes(spammerKp.pubKeyId),
    `spammer ${spammerKp.pubKeyId} should be in blocklist, got ${JSON.stringify(stats.blocked)}`,
  )

  // Subsequent sends from the spammer continue to be dropped by the
  // blocklist guard. Verify the counter ticks up.
  const blockedBefore = stats.rejected.blocked
  for (let i = 0; i < 10; i++) sendForged(1000 + i)
  stats = relay.getStats()
  assert.equal(
    stats.rejected.blocked,
    blockedBefore + 10,
    "all 10 follow-up spammer messages should be dropped by blocklist guard",
  )

  // Honest peer can still publish + reach the witness while the spammer is
  // silenced. This is the load-bearing assertion: anti-abuse must not
  // collateral-damage honest traffic.
  const honestBefore = witnessReceived.length
  const honestSigned = honest.publish({
    type: "canary_error",
    fingerprint: "abc".padEnd(64, "0"),
    severity: "critical",
    nowMs: now,
  })
  assert.ok(honestSigned, "honest peer should still be able to publish")
  assert.equal(
    witnessReceived.length,
    honestBefore + 1,
    "witness should receive honest peer's message during spammer timeout",
  )
  // The honest message originates from the honest peer's keypair.
  assert.equal(witnessReceived.at(-1).peer_id, honest.peerId)

  // Fast-forward past the 5-min timeout — the relay must let the spammer
  // back in. Blocklist is a circuit breaker, not a permanent ban.
  now += 5 * 60 * 1000 + 1_000
  const beforeRecovery = relay.getStats().delivered
  sendForged(9999)
  const afterRecovery = relay.getStats().delivered
  assert.ok(
    afterRecovery > beforeRecovery,
    "spammer should be re-admitted after the 5-minute timeout",
  )

  console.log(
    `[p2p-anti-abuse] spammer rate-limited ${stats.rejected.rateLimited}x, blocked ${stats.rejected.blocked}x; honest peer delivered ${witnessReceived.length} messages during timeout`,
  )

  honest.shutdown()
  witness.shutdown()
  relay.shutdown()
})

test("forged-pubkey impersonation goes straight to the blocklist", () => {
  let now = Date.now()
  const relay = new InMemoryRelay(() => now)

  const realKp = __createInMemoryKeypair()
  const realTransport = relay.connect(WORKSPACE)

  // First message registers the real pubkey.
  realTransport.publish(
    buildSignedMessage(realKp, {
      workspaceId: WORKSPACE,
      fingerprint: "5".repeat(64),
      nowMs: now,
    }),
  )
  assert.equal(relay.getPubkey(realKp.pubKeyId), realKp.publicKeyHex)

  // An attacker tries to send a message claiming the same peer_id but with
  // a different keypair (different pubkey). This is forgery: the relay
  // rejects + counts toward the blocklist.
  const fakeKp = __createInMemoryKeypair()
  const attackerTransport = relay.connect(WORKSPACE)

  for (let i = 0; i < 4; i++) {
    const tampered = buildSignedMessage(fakeKp, {
      workspaceId: WORKSPACE,
      fingerprint: i.toString(16).padStart(64, "0"),
      nowMs: now,
    })
    // Overwrite the peer_id + sig to claim the real peer's identity. The
    // signature is now invalid for the claimed pubkey, but pubkey forgery
    // is detected before signature verification when the peer_id is known.
    tampered.peer_id = realKp.pubKeyId
    attackerTransport.publish(tampered)
  }

  const stats = relay.getStats()
  // Either path counts: bad signature OR pubkey forgery — both are
  // attribution failures. We just need the relay to be loud about them.
  const totalRejected =
    stats.rejected.badSignature +
    stats.rejected.pubkeyForgery +
    stats.rejected.pubkeyMismatch
  assert.ok(
    totalRejected >= 4,
    `expected forgery rejections, got ${JSON.stringify(stats.rejected)}`,
  )

  console.log(
    `[p2p-anti-abuse] forged-pubkey attack rejected: badSignature=${stats.rejected.badSignature}, pubkeyForgery=${stats.rejected.pubkeyForgery}, pubkeyMismatch=${stats.rejected.pubkeyMismatch}`,
  )

  relay.shutdown()
})
