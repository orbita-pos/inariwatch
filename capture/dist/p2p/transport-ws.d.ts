/**
 * WebSocket transport — production path. Targets the Cloudflare Durable
 * Object server defined in `server-cf.ts`.
 *
 * Why the SDK can write a WS client today even though the CF Worker isn't
 * deployed yet (Sesión 14): the wire format is plain JSON over a single WS
 * connection per `(workspace_id, peer_id)`. Same shape as a typical
 * Pusher/Ably client. Standing the CF Worker up later is a server-side
 * change; the SDK doesn't need a redeploy.
 *
 * Browser-friendly: uses globalThis.WebSocket on browsers and Node 22+. On
 * older Node, the constructor short-circuits to a no-op transport (publish
 * silently drops, onMessage never fires) — the SDK gracefully degrades to
 * the DB-only path. The dev should not ship a workspace that needs gossip
 * on Node 18; we'll add a startup warning when we ship the CF Worker.
 */
import type { P2PMessage } from "./client.js";
import type { Transport } from "./transport.js";
export interface WsTransportOptions {
    /** Base URL — e.g. `wss://gossip.inariwatch.com/v1`. */
    endpoint: string;
    workspaceId: string;
    peerId: string;
    /** Hex-encoded 32-byte Ed25519 pubkey — relay uses it to seed the registry. */
    pubkey: string;
    /** Optional bearer token issued by the workspace DSN. */
    authToken?: string;
    /** Override for tests — defaults to globalThis.WebSocket. */
    wsImpl?: WebSocketCtor;
}
type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;
interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: "open", listener: () => void): void;
    addEventListener(type: "message", listener: (ev: {
        data: unknown;
    }) => void): void;
    addEventListener(type: "close", listener: () => void): void;
    addEventListener(type: "error", listener: () => void): void;
}
export declare class WebSocketTransport implements Transport {
    private readonly opts;
    private readonly incoming;
    private ws;
    private queue;
    private retryDelayMs;
    private closed;
    private readonly Ctor;
    constructor(opts: WsTransportOptions);
    publish(msg: P2PMessage): void;
    onMessage(handler: (msg: P2PMessage) => void): () => void;
    shutdown(): void;
    private connect;
    private scheduleReconnect;
    private buildUrl;
}
export {};
//# sourceMappingURL=transport-ws.d.ts.map