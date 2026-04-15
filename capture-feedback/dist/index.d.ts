/**
 * @inariwatch/capture-feedback — user feedback widget for @inariwatch/capture.
 *
 * Floating button → modal with description + email + optional screenshot.
 * Screenshot uses the browser's native Screen Capture API (no html2canvas,
 * no node_modules bloat). User approves a native dialog before anything is
 * captured — no silent screenshot ever.
 *
 * Usage:
 *   import { init } from "@inariwatch/capture"
 *   import { feedbackIntegration } from "@inariwatch/capture-feedback"
 *
 *   init({
 *     dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
 *     integrations: [feedbackIntegration({ position: "bottom-right" })],
 *   })
 */
import type { Integration } from "@inariwatch/capture";
import { type WidgetOptions, type FeedbackPayload } from "./widget.js";
export type { WidgetOptions, FeedbackPayload } from "./widget.js";
export interface FeedbackOptions extends WidgetOptions {
    /** Custom callback invoked on submit. Runs BEFORE the default captureLog send — return `false` to skip default send. */
    onSubmit?: (payload: FeedbackPayload) => boolean | void;
}
/**
 * Create a feedback integration. Pass to `init({ integrations: [...] })`.
 *
 * No-ops on the server (renders into DOM). Safe to import from isomorphic
 * code paths.
 */
export declare function feedbackIntegration(options?: FeedbackOptions): Integration;
//# sourceMappingURL=index.d.ts.map