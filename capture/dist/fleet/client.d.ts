/**
 * Fleet bloom client — fetches the public bloom, holds in memory, exposes
 * `hasAnyoneElseHit(fingerprint)` synchronously.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 */
export interface FleetBloomClientOptions {
    /** Base URL of an InariWatch server. Defaults to https://app.inariwatch.com */
    baseUrl?: string;
    /** Soft deadline on the initial fetch. Default: 200ms (Q5.4 acceptance). */
    initTimeoutMs?: number;
    /** Periodic refresh interval. Default: 86400 (24h). 0 disables refresh. */
    refreshSeconds?: number;
    /** Optional debug logger. */
    debug?: (msg: string, ctx?: Record<string, unknown>) => void;
}
export interface FleetBloomMeta {
    versionTag: string;
    count: number;
    fpr: number;
    builtAt: string;
    byteSize: number;
}
export declare class FleetBloomClient {
    private bloom;
    private meta;
    private etag;
    private readonly baseUrl;
    private readonly initTimeoutMs;
    private readonly refreshSeconds;
    private readonly debug?;
    private refreshTimer;
    constructor(opts?: FleetBloomClientOptions);
    /**
     * Fetch the bloom now. Resolves when loaded (or skipped). NEVER throws —
     * a slow/down server must not block SDK init.
     */
    init(): Promise<void>;
    /** Stop the background refresh. */
    close(): void;
    /**
     * Synchronous bloom membership check. Returns false when the bloom isn't
     * loaded (yet) — never blocks. Sub-microsecond lookup.
     */
    hasAnyoneElseHit(fingerprint: string): boolean;
    /** Current loaded bloom metadata, or null if not loaded. */
    getMeta(): FleetBloomMeta | null;
    /** Force a refresh outside the timer. Returns whether it loaded fresh data. */
    refresh(): Promise<boolean>;
    private fetchOnce;
}
/**
 * Best-effort live observation: when the SDK sees an error not covered by
 * the bloom, POST the fingerprint to the public observe endpoint so the
 * next bloom build picks it up. Caps at one POST per process per
 * fingerprint via an in-memory Set.
 */
export declare function contributeFingerprint(baseUrl: string, fingerprint: string, meta?: {
    framework?: string;
    language?: string;
}): Promise<boolean>;
/** Test-only: clear the in-process contribution dedup set. */
export declare function __resetContributionsForTesting(): void;
//# sourceMappingURL=client.d.ts.map