import type { ParsedDsn } from "./dsn.js";
import type { ErrorEvent } from "./types.js";
export interface Transport {
    send(event: ErrorEvent): void | Promise<void>;
    flush(timeoutMs?: number): Promise<void>;
}
/** Pretty-prints to console — used when no DSN is configured. */
export declare class LocalTransport implements Transport {
    send(event: ErrorEvent): void;
    flush(): Promise<void>;
}
/**
 * Beacon-friendly remote transport. Tries `navigator.sendBeacon` first
 * (best for unload events) and falls back to `fetch` with `keepalive: true`
 * which is the modern equivalent for live pages.
 *
 * Bounded retry buffer: 30 events deduped by fingerprint.
 */
export declare class RemoteTransport implements Transport {
    private parsed;
    private retry;
    private seen;
    constructor(parsed: ParsedDsn);
    send(event: ErrorEvent): Promise<void>;
    private sendOne;
    private enqueue;
    flush(): Promise<void>;
}
//# sourceMappingURL=transport.d.ts.map