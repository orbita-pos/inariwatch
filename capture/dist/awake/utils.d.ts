import type { AwakeConfig } from "../types.js";
/** Short CSS selector for an element — best-effort, not guaranteed unique. */
export declare function elSelector(el: Element): string;
/** Apply optional pathname redaction from AwakeConfig. */
export declare function getPathname(config: AwakeConfig): string | undefined;
/** Schedule work during browser idle time (with a 5-second deadline). */
export declare function onIdle(cb: () => void): void;
export declare function ratingForMs(ms: number, goodThreshold: number, poorThreshold: number): "good" | "needs-improvement" | "poor";
export declare function levelForRating(rating: "good" | "needs-improvement" | "poor"): "info" | "warn" | "error";
export declare function meetsMinRating(rating: "good" | "needs-improvement" | "poor", min: "good" | "needs-improvement" | "poor"): boolean;
//# sourceMappingURL=utils.d.ts.map