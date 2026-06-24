/**
 * Console + network ring buffers for visual reports.
 *
 * Installed at SDK boot (via `visualReportIntegration.setup`) so that by the
 * time a user clicks "Report bug" the rings already hold the recent context
 * needed for AI diagnosis. Both are bounded — old entries fall off the back
 * to keep memory + payload constant.
 *
 * Privacy:
 *   - Console: arguments are JSON-stringified with a safe serializer that
 *     drops functions, DOM nodes, and oversized values. PII redaction is
 *     done server-side via the existing `lib/redact/` patterns at submit
 *     time — keeping it here would double the work on every console.* call.
 *   - Network: only the URL + status + timing are captured by default.
 *     Bodies are NOT captured (large + privacy risk). The PerformanceObserver
 *     path is sufficient for "what requests fired recently".
 */
export type ConsoleEntry = {
    level: "log" | "info" | "warn" | "error" | "debug";
    ts: number;
    args: unknown[];
    site: string | null;
};
export declare function installConsoleRing(): void;
export declare function readConsoleRing(): ConsoleEntry[];
export type NetworkEntry = {
    url: string;
    method: string;
    status: number | null;
    ts: number;
    durMs: number | null;
    size: number | null;
    source: "fetch" | "xhr" | "performance";
};
export declare function installNetworkRing(): void;
export declare function readNetworkRing(): NetworkEntry[];
//# sourceMappingURL=rings.d.ts.map