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
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const QUEUE_MAX = 100;
const WS_OPEN = 1;
export class WebSocketTransport {
    constructor(opts) {
        this.opts = opts;
        this.incoming = new Set();
        this.ws = null;
        this.queue = [];
        this.retryDelayMs = RECONNECT_INITIAL_MS;
        this.closed = false;
        this.Ctor =
            opts.wsImpl ??
                (typeof globalThis.WebSocket ===
                    "function"
                    ? globalThis.WebSocket
                    : null);
        if (!this.Ctor) {
            // No WebSocket available — keep the transport object alive so callers
            // can still call publish/onMessage without crashing. Both will be
            // no-ops; the caller should detect this via the warning we'll surface
            // alongside `INARIWATCH_P2P=true` startup.
            this.closed = true;
            return;
        }
        this.connect();
    }
    publish(msg) {
        if (this.closed)
            return;
        if (this.ws && this.ws.readyState === WS_OPEN) {
            this.ws.send(JSON.stringify(msg));
            return;
        }
        // Queue while disconnected — bounded to avoid memory growth on prolonged
        // outages. Oldest message is dropped first; gossip is best-effort anyway.
        if (this.queue.length >= QUEUE_MAX)
            this.queue.shift();
        this.queue.push(msg);
    }
    onMessage(handler) {
        this.incoming.add(handler);
        return () => {
            this.incoming.delete(handler);
        };
    }
    shutdown() {
        this.closed = true;
        this.incoming.clear();
        this.queue = [];
        try {
            this.ws?.close();
        }
        catch {
            // ignore
        }
        this.ws = null;
    }
    connect() {
        if (this.closed || !this.Ctor)
            return;
        const url = this.buildUrl();
        let ws;
        try {
            ws = new this.Ctor(url);
        }
        catch {
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.addEventListener("open", () => {
            this.retryDelayMs = RECONNECT_INITIAL_MS;
            // Drain whatever queued during the outage. Order preserved.
            const drained = this.queue;
            this.queue = [];
            for (const msg of drained) {
                try {
                    ws.send(JSON.stringify(msg));
                }
                catch {
                    // If send fails the close handler will reconnect us.
                    break;
                }
            }
        });
        ws.addEventListener("message", (ev) => {
            try {
                const text = typeof ev.data === "string" ? ev.data : String(ev.data);
                const msg = JSON.parse(text);
                for (const handler of this.incoming) {
                    try {
                        handler(msg);
                    }
                    catch {
                        // Subscriber threw — same isolation policy as client.ts.
                    }
                }
            }
            catch {
                // Drop malformed frames silently.
            }
        });
        ws.addEventListener("close", () => {
            this.ws = null;
            this.scheduleReconnect();
        });
        ws.addEventListener("error", () => {
            // The `close` handler runs after `error` and owns reconnect — leaving
            // this empty so we don't double-schedule.
        });
    }
    scheduleReconnect() {
        if (this.closed)
            return;
        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, RECONNECT_MAX_MS);
        setTimeout(() => this.connect(), delay).unref?.();
    }
    buildUrl() {
        const base = this.opts.endpoint.replace(/\/+$/, "");
        const path = `/ws/${encodeURIComponent(this.opts.workspaceId)}`;
        const params = new URLSearchParams({
            peer_id: this.opts.peerId,
            pubkey: this.opts.pubkey,
        });
        if (this.opts.authToken)
            params.set("token", this.opts.authToken);
        return `${base}${path}?${params.toString()}`;
    }
}
//# sourceMappingURL=transport-ws.js.map