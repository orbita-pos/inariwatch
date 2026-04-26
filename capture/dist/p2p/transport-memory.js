/**
 * In-process transport for tests. Pairs with `relay.ts`.
 *
 * The InMemoryRelay creates one transport per peer it accepts via
 * `connect()`; the peer hands the transport to `createPeer({ transport })`.
 * Publishes go through the relay (server-side anti-abuse + fan-out), and the
 * relay dispatches accepted messages back to each peer's `deliver()`.
 *
 * Deliberately synchronous — keeps latency assertions in the e2e tests
 * unambiguous (any non-zero number is wall-clock noise, not transport debt).
 */
export class InMemoryTransport {
    constructor() {
        this.incoming = new Set();
        this.outgoing = null;
        this.closed = false;
    }
    /** Wired by the relay during `connect()`. Public for the relay only. */
    __setOutgoing(fn) {
        this.outgoing = fn;
    }
    /** Called by the relay when it routes a message to this peer. */
    __deliver(msg) {
        if (this.closed)
            return;
        for (const handler of this.incoming) {
            try {
                handler(msg);
            }
            catch {
                // Subscriber threw — same policy as client.ts: swallow and continue.
            }
        }
    }
    publish(msg) {
        if (this.closed || !this.outgoing)
            return;
        this.outgoing(msg);
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
        this.outgoing = null;
    }
}
//# sourceMappingURL=transport-memory.js.map