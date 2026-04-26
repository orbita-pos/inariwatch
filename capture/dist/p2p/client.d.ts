/**
 * @inariwatch/capture — P2P gossip mesh client (Track F · piece 8).
 *
 * Sesión 12 shipped the design + skeleton (no transport).
 * Sesión 13 wires real transports + a server-side relay (`relay.ts` for
 * tests, `server-cf.ts` deployable to Cloudflare Durable Objects).
 *
 * Opt-in: gated by `INARIWATCH_P2P=true` env var (or `peerEnable({ enabled:
 * true })`). When the flag is off, every export here is a cheap no-op and
 * no transport module is loaded — the v0.9.x bundle stays byte-identical
 * for users who haven't opted in.
 *
 * Two surfaces ship from this file:
 *
 *   1. **Singleton API** (`peerEnable`, `peerPublish`, `peerSubscribe`,
 *      `peerAdmit`, `peerShutdown`) — convenient for SDK consumers, where
 *      one process == one install == one peer.
 *
 *   2. **Factory API** (`createPeer({ keypair, transport, ... })`) — used
 *      by tests that need multiple peers in the same process and by future
 *      multi-tenant deployments. The singleton above is itself a thin
 *      wrapper around the factory.
 *
 * See `capture/P2P_DESIGN.md` for the wire protocol, ADRs, and rollout
 * plan.
 */
import { type SDKKeypair } from "../signing.js";
import type { Transport } from "./transport.js";
/** Wire format version. Bumping this is a breaking change. */
declare const WIRE_VERSION: 1;
/** Public message envelope — see P2P_DESIGN.md §4.1. */
export interface P2PMessage {
    v: typeof WIRE_VERSION;
    type: "canary_error" | "fingerprint_seen";
    workspace_id: string;
    peer_id: string;
    fingerprint: string;
    severity: "critical" | "error" | "warning" | "info";
    count: number;
    ts: string;
    pubkey: string;
    sig: string;
}
export interface PeerConfig {
    /** When false (default) the module is a no-op. Reads `INARIWATCH_P2P` if omitted. */
    enabled?: boolean;
    /** Required to publish. Provided by the workspace's DSN at SDK init time. */
    workspaceId?: string;
    /** Override the rendezvous endpoint — e.g. for tests against a local CF Workers wrangler. */
    endpoint?: string;
}
export interface CreatePeerOptions extends PeerConfig {
    /**
     * Inject a keypair directly. Bypasses `getOrCreateKeypair()` and the
     * filesystem — used by tests that need 3 distinct peers in one process.
     */
    keypair?: SDKKeypair;
    /**
     * Inject a transport. The factory binds the transport's incoming-message
     * stream to `peer.admit()` automatically. If omitted, `publish()` still
     * signs envelopes but they go nowhere — useful for unit tests.
     */
    transport?: Transport;
}
export interface PublishInput {
    type: P2PMessage["type"];
    fingerprint: string;
    severity: P2PMessage["severity"];
    count?: number;
    /** Override clock for tests — defaults to Date.now(). */
    nowMs?: number;
}
export interface Peer {
    readonly enabled: boolean;
    readonly peerId: string | null;
    /** Sign + publish (if a transport is attached). Returns the signed envelope or null. */
    publish(input: PublishInput): P2PMessage | null;
    /** Register a callback for accepted incoming messages. Returns an unsubscribe handle. */
    subscribe(handler: (msg: P2PMessage) => void): () => void;
    /** Admit an envelope (used by transports + tests). */
    admit(msg: P2PMessage, opts?: {
        nowMs?: number;
    }): boolean;
    /** Tear down — clears subscribers, disables the runtime, shuts the transport. */
    shutdown(): void;
}
/**
 * Construct an isolated peer instance. Multiple peers can coexist in one
 * process — useful for the 3-node e2e test and for any future multi-tenant
 * worker that brokers gossip on behalf of several workspaces.
 *
 * No-op when `enabled` is false — does not load a transport, does not hit
 * the filesystem, does not allocate a keypair.
 */
export declare function createPeer(options?: CreatePeerOptions): Peer;
export declare function peerEnable(config?: PeerConfig): void;
export declare function peerEnabled(): boolean;
export declare function peerPublish(input: PublishInput): P2PMessage | null;
export declare function peerSubscribe(handler: (msg: P2PMessage) => void): () => void;
export declare function peerShutdown(): void;
export declare function peerAdmit(msg: P2PMessage, opts?: {
    nowMs?: number;
}): boolean;
/** Test seam — clear singleton so tests can re-initialize cleanly. */
export declare function __resetPeerForTesting(): void;
/** Test seam — attach a transport to the singleton (used by p2p.test.mjs). */
export declare function __attachTransportForTesting(transport: Transport): void;
/**
 * Stable JSON serialization — sorted keys, no whitespace, UTF-8. Must match
 * the algorithm spelled out in P2P_DESIGN.md §4.1 step 2 so signature
 * verification is uniform across SDK languages.
 */
export declare function canonicalize(obj: Record<string, unknown>): string;
export {};
//# sourceMappingURL=client.d.ts.map