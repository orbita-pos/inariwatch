/**
 * Ed25519 client signing for Payload v2 (Track A piece 17, SDK side).
 *
 * Each install gets its own keypair, generated lazily on first sign and
 * persisted to `~/.inariwatch/keypair.json`. The public key is reported to
 * the server inside every signed event (`signature.signer_pubkey`). The
 * server can verify without a separate handshake — first event IS the
 * handshake.
 *
 * Protocol — byte-identical to `web/lib/services/eap-verify-local.ts`
 * (`verifyEd25519Signature`):
 *
 *   digest    = SHA-256(receipt_id_hex_utf8_bytes)
 *   signature = Ed25519.sign(private_key, digest)
 *
 * `receipt_id` is the Merkle root over the canonical evidence pack
 * (computed in payload-v2.ts). The pre-hash domain-separates the signing
 * input from arbitrary message contents — same trick the EAP server uses.
 *
 * Edge / Browser fallback:
 *   - `node:crypto` and the filesystem are unavailable. Signing skips and
 *     `signPayload` returns null. Caller MUST handle null and fall back to
 *     v1 wire format (server only enforces signatures for `schema_version: 2.0`).
 *
 * Zero deps. Native `node:crypto` only.
 */
import { type KeyObject } from "node:crypto";
export interface SDKKeypair {
    /** PEM-encoded private key — kept in memory only. */
    privateKey: KeyObject;
    publicKeyHex: string;
    pubKeyId: string;
}
/**
 * Returns the active keypair, loading from disk or generating + persisting
 * a fresh one on first call. Throws on environments without `node:crypto` —
 * caller in `client.ts` catches and falls back to v1 transport.
 */
export declare function getOrCreateKeypair(opts?: {
    keyPath?: string;
}): SDKKeypair;
/**
 * Sign a Merkle root with the install keypair. Returns 128-char hex signature.
 *
 * Protocol:  sig = Ed25519.sign(privateKey, SHA-256(receiptId.utf8))
 *
 * `receiptId` is the 64-char hex Merkle root of the canonical evidence pack.
 * The SHA-256 pre-hash matches the EAP server's signing layer so the same
 * `verifyEd25519Signature` function on the server validates SDK signatures
 * with no protocol fork.
 */
export declare function signReceiptId(receiptIdHex: string, kp: SDKKeypair): string;
/**
 * Verify a signature locally — used by tests so we don't have to import
 * server code. Mirrors `verifyEd25519Signature` exactly.
 */
export declare function verifyReceiptIdSignature(receiptIdHex: string, signatureHex: string, publicKeyHex: string): boolean;
/** Test-only: clears the in-process cached keypair so tests can swap key paths. */
export declare function __resetSigningCacheForTesting(): void;
/**
 * Test-only: produce an ephemeral keypair without touching disk or the
 * module-level cache. Lets multiple peers coexist in one process (e.g. the
 * 3-node gossip e2e test in `test/p2p-e2e.test.mjs`).
 */
export declare function __createInMemoryKeypair(): SDKKeypair;
//# sourceMappingURL=signing.d.ts.map