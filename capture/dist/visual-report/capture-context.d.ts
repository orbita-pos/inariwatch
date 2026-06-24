/**
 * Build the rich "what was on screen when the user reported a bug" bundle.
 *
 * Called by the visual-report integration's submit handler. Synchronous-ish:
 * the only async step is web-vitals reads, which are already buffered.
 *
 * Bounded by design — the whole bundle stays under ~150KB pre-gzip so the
 * upload fits the endpoint's 500KB hard cap even with the screenshot.
 *
 * What we capture in V0:
 *   - URL, viewport, userAgent, build_id (Next.js / generic meta tag)
 *   - Focused element: outerHTML + computed style subset + CSS path
 *   - Console ring (rings.ts) — last 50 entries
 *   - Network ring (rings.ts) — last 20 fetches/XHRs/resource timings
 *   - Web Vitals if `web-vitals` peer is installed
 *   - Performance memory (Chrome only)
 *
 * Deferred to V0.5: React fiber state (bippy), Vue/Pinia, full DOM
 * snapshot (rrweb), accessibility tree.
 */
import { type ConsoleEntry, type NetworkEntry } from "./rings.js";
export interface CaptureBundle {
    /** Page URL (sans hash for privacy — hashes often hold OAuth state). */
    url: string;
    /** Browser-reported user agent, truncated. */
    userAgent: string;
    viewport: {
        width: number;
        height: number;
        dpr: number;
    };
    /** Build id from Next.js `__NEXT_DATA__` or `<meta name="build-id">`. */
    buildId: string | null;
    /** When the bundle was assembled (ms epoch). */
    capturedAt: number;
    /** Element under cursor or activeElement at submit. */
    focused: FocusedElementInfo | null;
    console: ConsoleEntry[];
    network: NetworkEntry[];
    webVitals?: WebVitalsSnapshot;
    memory?: MemorySnapshot;
    /** How long capture() took, ms. Telemetry only. */
    captureMs: number;
}
export interface FocusedElementInfo {
    /** Up to 2000 chars of outerHTML — bounded to keep payload small. */
    outerHtml: string;
    /** Best-effort unique CSS selector. */
    selector: string;
    /** Subset of computed styles relevant to layout/visual bugs. */
    styles: Record<string, string>;
    /** Tag, role, accessible name heuristic. */
    ax: {
        tag: string;
        role: string | null;
        name: string | null;
        disabled: boolean;
    };
    /** Bounding rect at capture time. */
    rect: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
}
export interface WebVitalsSnapshot {
    lcp?: number;
    cls?: number;
    inp?: number;
    fcp?: number;
    ttfb?: number;
}
export interface MemorySnapshot {
    used: number;
    total: number;
    limit: number;
}
/**
 * Coordinates exist? — provide them to anchor `focused` to whatever was under
 * the pointer when the report button was clicked. When omitted, falls back
 * to `document.activeElement`, then `document.body`.
 */
export interface CaptureOptions {
    pointerX?: number;
    pointerY?: number;
}
export declare function captureContext(options?: CaptureOptions): Promise<CaptureBundle>;
//# sourceMappingURL=capture-context.d.ts.map