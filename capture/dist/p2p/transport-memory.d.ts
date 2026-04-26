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
import type { P2PMessage } from "./client.js";
import type { Transport } from "./transport.js";
export declare class InMemoryTransport implements Transport {
    private readonly incoming;
    private outgoing;
    private closed;
    /** Wired by the relay during `connect()`. Public for the relay only. */
    __setOutgoing(fn: (msg: P2PMessage) => void): void;
    /** Called by the relay when it routes a message to this peer. */
    __deliver(msg: P2PMessage): void;
    publish(msg: P2PMessage): void;
    onMessage(handler: (msg: P2PMessage) => void): () => void;
    shutdown(): void;
}
//# sourceMappingURL=transport-memory.d.ts.map