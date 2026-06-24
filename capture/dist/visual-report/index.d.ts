/**
 * @inariwatch/capture/visual-report — user-initiated "report visual bug"
 * integration. Mounts a floating button + modal (reuses the feedback
 * widget primitive for the UI) and on submit:
 *
 *   1. Captures rich diagnostic context (DOM, console ring, network ring,
 *      build_id, Web Vitals, performance memory).
 *   2. Bundles it with the user's screenshot + description.
 *   3. POSTs to /api/capture/user-report/[projectId] for the AI diagnosis
 *      pipeline (triage → diagnose → critique).
 *
 * The console + network rings are installed at SDK boot so by the time
 * the user clicks "Report bug" the rings already hold the recent activity
 * needed by the AI to root-cause without guessing.
 *
 * Usage:
 *   import { init } from "@inariwatch/capture"
 *   import { visualReportIntegration } from "@inariwatch/capture/visual-report"
 *
 *   init({
 *     dsn:        process.env.NEXT_PUBLIC_INARIWATCH_DSN,
 *     projectId:  process.env.NEXT_PUBLIC_INARIWATCH_PROJECT_ID,
 *     integrations: [
 *       visualReportIntegration({
 *         position:    "bottom-right",
 *         buttonLabel: "Report visual bug",
 *       }),
 *     ],
 *   })
 */
import type { Integration } from "../types.js";
import { type WidgetOptions } from "../feedback/widget.js";
import { captureContext } from "./capture-context.js";
import { type UploadResult } from "./upload.js";
export type { CaptureBundle, FocusedElementInfo } from "./capture-context.js";
export type { UploadResult, UploadInput } from "./upload.js";
export interface VisualReportOptions extends WidgetOptions {
    /**
     * Custom callback invoked on submit. Runs AFTER the rich-context capture
     * and BEFORE the default upload. Return `false` to skip the default upload
     * — useful for hosts that want to route reports through their own backend.
     */
    onSubmit?: (input: {
        description: string;
        email: string;
        screenshot?: string;
        bundle: Awaited<ReturnType<typeof captureContext>>;
    }) => boolean | void | Promise<boolean | void>;
    /**
     * Custom callback invoked AFTER the upload completes. Useful for "thanks"
     * UX or analytics. Receives the server response.
     */
    onUploaded?: (result: UploadResult) => void;
}
/**
 * Create the visual-report integration. Pass to `init({ integrations: [...] })`.
 *
 * No-ops on the server (renders into DOM). Safe to import from isomorphic
 * code paths because every browser-only call is gated on `typeof window`.
 */
export declare function visualReportIntegration(options?: VisualReportOptions): Integration;
//# sourceMappingURL=index.d.ts.map