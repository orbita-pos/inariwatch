/**
 * Capture Awake — proactive browser performance and UX monitoring.
 *
 * Zero-config. Installed automatically by `@inariwatch/capture/browser`.
 * Detects: Web Vitals (LCP/INP/CLS/TTFB/FCP), Long Animation Frames, broken
 * resources (404 images/scripts/fonts), slow images, slow API calls,
 * render-blocking resources, third-party script impact, rage clicks, dead clicks,
 * SPA route timing, memory leak heuristic, image optimization opportunities,
 * storage quota pressure, hydration mismatches, and excessive DOM size.
 *
 * Opt out: `init({ awake: false })` or `window.__INARIWATCH__ = { awake: false }`
 *
 * Selective disable:
 *   init({ awake: { disable: ["memory-leak", "image-optimizer"] } })
 */
import type { AwakeConfig } from "../types.js";
export type { AwakeConfig };
export declare function installAwake(config?: AwakeConfig): void;
//# sourceMappingURL=index.d.ts.map