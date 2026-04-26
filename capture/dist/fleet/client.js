/**
 * Fleet bloom client — fetches the public bloom, holds in memory, exposes
 * `hasAnyoneElseHit(fingerprint)` synchronously.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 */
import { deserialize, has } from "./bloom.js";
export class FleetBloomClient {
    constructor(opts = {}) {
        this.bloom = null;
        this.meta = null;
        this.etag = null;
        this.refreshTimer = null;
        this.baseUrl = (opts.baseUrl ?? "https://app.inariwatch.com").replace(/\/$/, "");
        this.initTimeoutMs = opts.initTimeoutMs ?? 200;
        this.refreshSeconds = opts.refreshSeconds ?? 86400;
        this.debug = opts.debug;
    }
    /**
     * Fetch the bloom now. Resolves when loaded (or skipped). NEVER throws —
     * a slow/down server must not block SDK init.
     */
    async init() {
        await this.fetchOnce(this.initTimeoutMs);
        if (this.refreshSeconds > 0) {
            this.refreshTimer = setInterval(() => {
                // Background refresh — no deadline. If it fails, last good copy stays.
                this.fetchOnce(30000).catch(() => { });
            }, this.refreshSeconds * 1000);
            // Don't keep the event loop alive just for refresh.
            this.refreshTimer.unref?.();
        }
    }
    /** Stop the background refresh. */
    close() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
    /**
     * Synchronous bloom membership check. Returns false when the bloom isn't
     * loaded (yet) — never blocks. Sub-microsecond lookup.
     */
    hasAnyoneElseHit(fingerprint) {
        if (!this.bloom)
            return false;
        return has(this.bloom, fingerprint);
    }
    /** Current loaded bloom metadata, or null if not loaded. */
    getMeta() {
        return this.meta;
    }
    /** Force a refresh outside the timer. Returns whether it loaded fresh data. */
    async refresh() {
        return this.fetchOnce(30000);
    }
    async fetchOnce(timeoutMs) {
        const url = `${this.baseUrl}/api/fleet/bloom/latest`;
        try {
            const headers = { accept: "application/octet-stream" };
            if (this.etag)
                headers["if-none-match"] = `"${this.etag}"`;
            const res = await fetch(url, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.status === 304) {
                this.debug?.("fleet-bloom: 304 not modified", { versionTag: this.etag });
                return false;
            }
            if (res.status === 503) {
                this.debug?.("fleet-bloom: 503 — server has no bloom yet");
                return false;
            }
            if (!res.ok) {
                this.debug?.("fleet-bloom: fetch failed", { status: res.status });
                return false;
            }
            const ab = await res.arrayBuffer();
            const buf = Buffer.from(ab);
            const bloom = deserialize(buf);
            this.bloom = bloom;
            const versionTag = res.headers.get("x-bloom-version") ?? "";
            this.etag = versionTag;
            this.meta = {
                versionTag,
                count: Number(res.headers.get("x-bloom-count") ?? bloom.count),
                fpr: Number(res.headers.get("x-bloom-fpr") ?? 0),
                builtAt: res.headers.get("x-bloom-built-at") ?? "",
                byteSize: buf.byteLength,
            };
            this.debug?.("fleet-bloom: loaded", { ...this.meta });
            return true;
        }
        catch (err) {
            this.debug?.("fleet-bloom: fetch threw", {
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }
}
/**
 * Best-effort live observation: when the SDK sees an error not covered by
 * the bloom, POST the fingerprint to the public observe endpoint so the
 * next bloom build picks it up. Caps at one POST per process per
 * fingerprint via an in-memory Set.
 */
export async function contributeFingerprint(baseUrl, fingerprint, meta) {
    if (!fingerprint)
        return false;
    if (_seenContributions.has(fingerprint))
        return false;
    _seenContributions.add(fingerprint);
    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/fleet/bloom/observe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fingerprint, ...meta }),
            signal: AbortSignal.timeout(2000),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
const _seenContributions = new Set();
/** Test-only: clear the in-process contribution dedup set. */
export function __resetContributionsForTesting() {
    _seenContributions.clear();
}
//# sourceMappingURL=client.js.map