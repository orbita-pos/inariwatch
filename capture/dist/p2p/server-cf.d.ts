/**
 * Cloudflare Durable Object server (Track F · piece 8 · Sesión 13).
 *
 * One Durable Object instance per workspace, addressed by `workspace_id`.
 * Cloudflare guarantees single-threaded execution and single-region
 * pinning per object — workspace isolation comes free.
 *
 * Wire format and anti-abuse rules are byte-identical to `relay.ts` (the
 * in-process test backend). Both files import the same helpers from
 * `relay.ts` so the protocol can never drift between test and prod.
 *
 * Deploy: see `capture/server/wrangler.toml` (Sesión 14). This file ships
 * with the SDK so the spec is co-located with the client; it's compiled
 * out of consumer bundles by tree-shaking (no consumer imports it).
 */
type CfWebSocket = {
    accept(): void;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "message", listener: (ev: {
        data: unknown;
    }) => void): void;
    addEventListener(type: "close", listener: () => void): void;
};
type CfDurableObjectState = {
    acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): CfWebSocket[];
};
interface Env {
    GOSSIP_ROOMS: {
        idFromName(name: string): unknown;
        get(id: unknown): {
            fetch(req: Request): Promise<Response>;
        };
    };
}
/** Top-level Worker entrypoint. Routes WS upgrades to the per-workspace DO. */
declare const worker: {
    fetch(req: Request, env: Env): Promise<Response>;
};
export default worker;
/**
 * Per-workspace gossip room. Holds open WebSockets via Hibernation API so we
 * pay $0 while idle. Anti-abuse state lives in-memory on the DO; CF reaps it
 * on object eviction, which is fine — blocklists are local circuit breakers,
 * not global sanctions (per ADR / §5.4).
 */
export declare class GossipRoom {
    private readonly state;
    private readonly registry;
    private readonly buckets;
    private readonly blocks;
    private readonly sessions;
    constructor(state: CfDurableObjectState);
    fetch(req: Request): Promise<Response>;
    /**
     * Hibernation API hook — runs even after the DO instance was unloaded.
     * The runtime restores the WS list via `getWebSockets()` and dispatches
     * each frame here.
     */
    webSocketMessage(ws: CfWebSocket, data: string | ArrayBuffer): Promise<void>;
    webSocketClose(ws: CfWebSocket): Promise<void>;
    private handlePublish;
    private consumeToken;
    private isBlocked;
    private recordRejection;
}
//# sourceMappingURL=server-cf.d.ts.map