/**
 * In-process relay implementing the same semantics as the Cloudflare Durable
 * Object server (`server-cf.ts`). Used by the e2e tests; the CF Worker reuses
 * the helpers below so the two stay byte-identical.
 *
 * Server-side responsibilities (per P2P_DESIGN.md §5):
 *   1. Workspace isolation — a peer connected to workspace W only ever sees
 *      messages from other peers in W.
 *   2. Pubkey distribution — first message from a peer registers their
 *      pubkey; subsequent messages with a different pubkey for the same
 *      peer_id are rejected (forgery defense).
 *   3. Signature verification — defense in depth. The receiver verifies too,
 *      but the relay drops obvious garbage so it doesn't fan out.
 *   4. Per-peer rate limit — tokens-per-minute bucket; overflow drops.
 *   5. Blocklist — N rate-limit rejections in a 5-minute window puts the
 *      peer on a 5-minute timeout. Forgery attempts go straight to the
 *      timeout list.
 *
 * Single-process / synchronous on purpose: tests assert end-to-end latency
 * without flake, and the CF Worker's WebSocket Hibernation API has the same
 * "single-threaded per Durable Object" guarantee, so the design carries.
 */
import { type P2PMessage } from "./client.js";
import { InMemoryTransport } from "./transport-memory.js";
export interface RelayStats {
    /** Total messages successfully fanned out (sender already excluded). */
    delivered: number;
    /** Messages dropped before fan-out, broken down by reason. */
    rejected: {
        workspaceMismatch: number;
        badSignature: number;
        pubkeyForgery: number;
        rateLimited: number;
        blocked: number;
        replay: number;
        pubkeyMismatch: number;
    };
    /** Peer ids currently in the timeout list. */
    blocked: string[];
}
export declare class InMemoryRelay {
    private readonly clock;
    private readonly entries;
    private readonly workspaces;
    private readonly buckets;
    private readonly blocks;
    /** peer_id → pubkey, accumulated from first accepted message. */
    private readonly registry;
    private readonly stats;
    /** Allow tests to inject `nowMs` for deterministic blocklist timing. */
    constructor(clock?: () => number);
    /**
     * Register a new peer connection. The returned transport is bound to the
     * relay — `publish()` runs through the anti-abuse pipeline; the relay
     * delivers fan-out via the transport's `__deliver()` hook.
     */
    connect(workspaceId: string): InMemoryTransport;
    /** Disconnect every peer and drop all relay state. */
    shutdown(): void;
    /** Snapshot — useful for asserting in tests. */
    getStats(): RelayStats;
    /** Pubkey distribution: lookup the registered pubkey for a peer_id. */
    getPubkey(peerId: string): string | null;
    private handlePublish;
    private consumeToken;
    private isBlocked;
    private recordRejection;
}
export declare function isFreshTimestamp(tsIso: string, nowMs: number): boolean;
export declare function isPeerIdConsistent(msg: P2PMessage): boolean;
export declare function verifySignatureV1(msg: P2PMessage): boolean;
//# sourceMappingURL=relay.d.ts.map