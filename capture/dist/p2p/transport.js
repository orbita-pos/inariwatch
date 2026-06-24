/**
 * @inariwatch/capture — P2P transport interface (Track F · piece 8 · Sesión 13).
 *
 * Per ADR-001 in `P2P_DESIGN.md`, the wire format is transport-agnostic. The
 * SDK only knows about this interface; concrete implementations are:
 *
 *   - `transport-memory.ts` — in-process fan-out used by the e2e test suite
 *     and by single-process integration tests.
 *   - `transport-ws.ts`     — WebSocket client for the Cloudflare Durable
 *     Object relay (`server-cf.ts`). Production path.
 *
 * Keep this file dependency-free so swapping transports later (e.g. NATS,
 * libp2p) is a single new file plus a wiring change, not a protocol fork.
 */
export {};
//# sourceMappingURL=transport.js.map