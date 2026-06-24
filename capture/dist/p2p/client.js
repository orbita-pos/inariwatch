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
import { createHash } from "node:crypto";
import { getOrCreateKeypair, signReceiptId, verifyReceiptIdSignature, } from "../signing.js";
/** Sliding-window length used by the dedup map. */
const DEDUP_WINDOW_MS = 10000;
/** Tokens-per-minute for the publisher and receiver buckets. */
const RATE_LIMIT_PER_MINUTE = 100;
/** Drop messages from the same peer about the same fingerprint after this many in `DEDUP_WINDOW_MS`. */
const DEDUP_MAX_PER_WINDOW = 3;
/** Three rate-limit rejections inside this window blocklists the peer. */
const BLOCKLIST_TRIGGER_WINDOW_MS = 5 * 60 * 1000;
const BLOCKLIST_TRIGGER_COUNT = 3;
const BLOCKLIST_DURATION_MS = 5 * 60 * 1000;
/** Receiver-side accept window for `ts` — 30 s past, 5 s future. */
const TS_ACCEPT_PAST_MS = 30000;
const TS_ACCEPT_FUTURE_MS = 5000;
/** Wire format version. Bumping this is a breaking change. */
const WIRE_VERSION = 1;
/** Module-level singleton runtime — used by the legacy peer*() API. */
let singleton = null;
function envEnabled() {
    if (typeof process === "undefined" || !process.env)
        return false;
    const flag = process.env.INARIWATCH_P2P;
    return flag === "true" || flag === "1";
}
function freshRuntime(config) {
    const enabled = config.enabled ?? envEnabled();
    return {
        config: {
            enabled,
            workspaceId: config.workspaceId,
            endpoint: config.endpoint,
        },
        keypair: null,
        transport: null,
        unsubscribeTransport: null,
        publishBucket: { tokens: RATE_LIMIT_PER_MINUTE, lastRefillMs: Date.now() },
        receiveBuckets: new Map(),
        dedupWindow: new Map(),
        blocklist: new Map(),
        subscribers: new Set(),
    };
}
function loadKeypair(rt, injected) {
    if (injected) {
        rt.keypair = injected;
        return;
    }
    // Lazily resolve the keypair on enable — `getOrCreateKeypair` reads
    // `~/.inariwatch/keypair.json`, which we don't want to touch unless the
    // install actually opts in. Browser hosts will throw here; the catch
    // keeps publish in a graceful no-op state.
    try {
        rt.keypair = getOrCreateKeypair();
    }
    catch {
        rt.keypair = null;
    }
}
function bindTransport(rt, transport) {
    if (!transport)
        return;
    rt.transport = transport;
    rt.unsubscribeTransport = transport.onMessage((msg) => {
        admitOnRuntime(rt, msg);
    });
}
function unbindTransport(rt) {
    rt.unsubscribeTransport?.();
    rt.unsubscribeTransport = null;
    if (rt.transport) {
        try {
            void rt.transport.shutdown();
        }
        catch {
            // Transport blew up on close — tests don't care, prod logs it elsewhere.
        }
    }
    rt.transport = null;
}
// ── Factory API ───────────────────────────────────────────────────────────────
/**
 * Construct an isolated peer instance. Multiple peers can coexist in one
 * process — useful for the 3-node e2e test and for any future multi-tenant
 * worker that brokers gossip on behalf of several workspaces.
 *
 * No-op when `enabled` is false — does not load a transport, does not hit
 * the filesystem, does not allocate a keypair.
 */
export function createPeer(options = {}) {
    const rt = freshRuntime(options);
    if (rt.config.enabled) {
        loadKeypair(rt, options.keypair);
        bindTransport(rt, options.transport);
    }
    return {
        get enabled() {
            return rt.config.enabled;
        },
        get peerId() {
            return rt.keypair?.pubKeyId ?? null;
        },
        publish: (input) => publishOnRuntime(rt, input),
        subscribe: (handler) => subscribeOnRuntime(rt, handler),
        admit: (msg, opts) => admitOnRuntime(rt, msg, opts),
        shutdown: () => shutdownRuntime(rt),
    };
}
// ── Singleton API (backward-compatible with Sesión 12) ───────────────────────
export function peerEnable(config = {}) {
    if (singleton)
        shutdownRuntime(singleton);
    singleton = freshRuntime(config);
    if (!singleton.config.enabled)
        return;
    loadKeypair(singleton, undefined);
}
export function peerEnabled() {
    return singleton?.config.enabled === true;
}
export function peerPublish(input) {
    if (!singleton)
        return null;
    return publishOnRuntime(singleton, input);
}
export function peerSubscribe(handler) {
    if (!singleton)
        return () => { };
    return subscribeOnRuntime(singleton, handler);
}
export function peerShutdown() {
    if (!singleton)
        return;
    shutdownRuntime(singleton);
}
export function peerAdmit(msg, opts = {}) {
    if (!singleton)
        return false;
    return admitOnRuntime(singleton, msg, opts);
}
/** Test seam — clear singleton so tests can re-initialize cleanly. */
export function __resetPeerForTesting() {
    if (singleton)
        shutdownRuntime(singleton);
    singleton = null;
}
/** Test seam — attach a transport to the singleton (used by p2p.test.mjs). */
export function __attachTransportForTesting(transport) {
    if (!singleton || !singleton.config.enabled)
        return;
    bindTransport(singleton, transport);
}
// ── Runtime operations (shared by both APIs) ─────────────────────────────────
function publishOnRuntime(rt, input) {
    if (!rt.config.enabled)
        return null;
    if (!rt.config.workspaceId)
        return null;
    if (!rt.keypair)
        return null;
    const nowMs = input.nowMs ?? Date.now();
    if (!consumeToken(rt.publishBucket, nowMs))
        return null;
    const unsigned = {
        v: WIRE_VERSION,
        type: input.type,
        workspace_id: rt.config.workspaceId,
        peer_id: rt.keypair.pubKeyId,
        fingerprint: input.fingerprint,
        severity: input.severity,
        count: input.count ?? 1,
        ts: new Date(nowMs).toISOString(),
    };
    const sigInput = canonicalize(unsigned);
    const digest = createHash("sha256").update(sigInput, "utf8").digest("hex");
    const sig = signReceiptId(digest, rt.keypair);
    const signed = {
        ...unsigned,
        pubkey: rt.keypair.publicKeyHex,
        sig,
    };
    if (rt.transport) {
        try {
            void rt.transport.publish(signed);
        }
        catch {
            // Transport failure must not crash captureException paths.
        }
    }
    return signed;
}
function subscribeOnRuntime(rt, handler) {
    if (!rt.config.enabled)
        return () => { };
    rt.subscribers.add(handler);
    return () => {
        rt.subscribers.delete(handler);
    };
}
function admitOnRuntime(rt, msg, opts = {}) {
    if (!rt.config.enabled)
        return false;
    if (msg.v !== WIRE_VERSION)
        return false;
    if (msg.workspace_id !== rt.config.workspaceId)
        return false;
    const nowMs = opts.nowMs ?? Date.now();
    if (!isFreshTimestamp(msg.ts, nowMs))
        return false;
    if (!isPeerIdConsistent(msg))
        return false;
    if (!verifySignature(msg))
        return false;
    if (isBlocked(rt.blocklist, msg.peer_id, nowMs))
        return false;
    const bucket = getOrCreateBucket(rt.receiveBuckets, msg.peer_id, nowMs);
    if (!consumeToken(bucket, nowMs)) {
        recordRejection(rt.blocklist, msg.peer_id, nowMs);
        return false;
    }
    if (isDuplicate(rt.dedupWindow, msg, nowMs))
        return false;
    for (const handler of rt.subscribers) {
        try {
            handler(msg);
        }
        catch {
            // Subscriber threw — silently swallow. A bad handler must not poison
            // the gossip path for the others.
        }
    }
    return true;
}
function shutdownRuntime(rt) {
    unbindTransport(rt);
    rt.subscribers.clear();
    rt.dedupWindow.clear();
    rt.receiveBuckets.clear();
    rt.blocklist.clear();
    rt.keypair = null;
    rt.config.enabled = false;
}
// ── Internal helpers (exported only for tests) ────────────────────────────────
/**
 * Stable JSON serialization — sorted keys, no whitespace, UTF-8. Must match
 * the algorithm spelled out in P2P_DESIGN.md §4.1 step 2 so signature
 * verification is uniform across SDK languages.
 */
export function canonicalize(obj) {
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
    return `{${parts.join(",")}}`;
}
function consumeToken(bucket, nowMs) {
    refillBucket(bucket, nowMs);
    if (bucket.tokens < 1)
        return false;
    bucket.tokens -= 1;
    return true;
}
function refillBucket(bucket, nowMs) {
    const elapsed = nowMs - bucket.lastRefillMs;
    if (elapsed <= 0)
        return;
    const refill = (elapsed / 60000) * RATE_LIMIT_PER_MINUTE;
    bucket.tokens = Math.min(RATE_LIMIT_PER_MINUTE, bucket.tokens + refill);
    bucket.lastRefillMs = nowMs;
}
function getOrCreateBucket(store, peerId, nowMs) {
    let bucket = store.get(peerId);
    if (!bucket) {
        bucket = { tokens: RATE_LIMIT_PER_MINUTE, lastRefillMs: nowMs };
        store.set(peerId, bucket);
    }
    return bucket;
}
function isDuplicate(store, msg, nowMs) {
    const key = `${msg.peer_id}|${msg.type}|${msg.fingerprint}`;
    const seen = store.get(key) ?? [];
    // Drop entries that fell out of the window.
    const fresh = seen.filter((t) => nowMs - t < DEDUP_WINDOW_MS);
    fresh.push(nowMs);
    store.set(key, fresh);
    // The 4th-and-onward identical message inside the window is dropped —
    // receivers can already infer escalation from `count`, so sending more is
    // just noise.
    return fresh.length > DEDUP_MAX_PER_WINDOW;
}
function isBlocked(store, peerId, nowMs) {
    const state = store.get(peerId);
    if (!state)
        return false;
    return state.blockedUntilMs > nowMs;
}
function recordRejection(store, peerId, nowMs) {
    let state = store.get(peerId);
    if (!state) {
        state = { rejections: [], blockedUntilMs: 0 };
        store.set(peerId, state);
    }
    state.rejections = state.rejections.filter((t) => nowMs - t < BLOCKLIST_TRIGGER_WINDOW_MS);
    state.rejections.push(nowMs);
    if (state.rejections.length >= BLOCKLIST_TRIGGER_COUNT) {
        state.blockedUntilMs = nowMs + BLOCKLIST_DURATION_MS;
        state.rejections = [];
    }
}
function isFreshTimestamp(tsIso, nowMs) {
    const ts = Date.parse(tsIso);
    if (Number.isNaN(ts))
        return false;
    if (ts > nowMs + TS_ACCEPT_FUTURE_MS)
        return false;
    if (ts < nowMs - TS_ACCEPT_PAST_MS)
        return false;
    return true;
}
function isPeerIdConsistent(msg) {
    try {
        const pubBytes = Buffer.from(msg.pubkey, "hex");
        if (pubBytes.length !== 32)
            return false;
        const derived = createHash("sha256").update(pubBytes).digest("hex").slice(0, 16);
        return derived === msg.peer_id;
    }
    catch {
        return false;
    }
}
function verifySignature(msg) {
    // Pull only the canonicalized fields — sig and pubkey are excluded by spec.
    const { sig: _sig, pubkey: _pubkey, ...rest } = msg;
    void _sig;
    void _pubkey;
    const sigInput = canonicalize(rest);
    const digest = createHash("sha256").update(sigInput, "utf8").digest("hex");
    // Reuse the existing signing module's verifier so the protocol stays in
    // lock-step with Payload v2's signing layer.
    return verifyReceiptIdSignature(digest, msg.sig, msg.pubkey);
}
//# sourceMappingURL=client.js.map