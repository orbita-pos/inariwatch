/**
 * Zero-retention tombstone storage — Track E pieza 11.
 *
 * When `INARIWATCH_ZERO_RETENTION=true` the SDK adds the
 * `X-IW-Zero-Retention: 1` header to every transport request. The server
 * never persists the event; instead it returns a signed tombstone:
 *
 *   {
 *     v: 1,
 *     ts: "2026-04-25T...",
 *     fingerprint_hash: "<sha256 of fingerprint>",
 *     processed_actions: ["analyzed", "deduplicated", "notified"],
 *     integration_id: "<uuid>",
 *     key_id: "<16 hex>",
 *     tombstone_id: "<64 hex>",
 *     sig: "ed25519:<128 hex>",
 *     pubkey: "<64 hex>"
 *   }
 *
 * We append each tombstone to `~/.inariwatch/tombstones.jsonl` so a
 * compliance auditor can replay and verify them later via
 * `POST /api/eap/verify/tombstone/:hash`.
 *
 * Browser/edge: silently no-op — the spec only makes sense in Node, and
 * compliance clients always run their backends on Node/Python anyway.
 */
export interface SignedTombstone {
    v: 1;
    ts: string;
    fingerprint_hash: string;
    processed_actions: string[];
    integration_id: string;
    key_id: string;
    tombstone_id: string;
    sig: string;
    pubkey: string;
}
export declare function isZeroRetentionEnabled(): boolean;
/** Test seam — let unit tests flip the flag without setenv. */
export declare function setZeroRetentionForTesting(value: boolean): void;
/**
 * Append a tombstone to the local audit log. Best-effort: we never throw
 * out of this — the SDK should never crash because a tombstone failed to
 * persist (the original error already failed, that's enough).
 *
 * Browser hosts: no-op (no fs).
 */
export declare function persistTombstone(tombstone: SignedTombstone): Promise<void>;
/**
 * Try to extract a SignedTombstone from a webhook response body. Returns
 * null when the response shape doesn't match (legacy server, error, etc.).
 *
 * The transport calls this on every successful send; null returns mean
 * "this server didn't tombstone the event" — no further action needed.
 */
export declare function extractTombstone(json: unknown): SignedTombstone | null;
//# sourceMappingURL=tombstone.d.ts.map