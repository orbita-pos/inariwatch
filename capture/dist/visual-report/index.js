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
import { mountFeedbackWidget } from "../feedback/widget.js";
import { installConsoleRing, installNetworkRing } from "./rings.js";
import { captureContext } from "./capture-context.js";
import { uploadVisualReport } from "./upload.js";
/**
 * Create the visual-report integration. Pass to `init({ integrations: [...] })`.
 *
 * No-ops on the server (renders into DOM). Safe to import from isomorphic
 * code paths because every browser-only call is gated on `typeof window`.
 */
export function visualReportIntegration(options = {}) {
    return {
        name: "VisualReport",
        setup(config) {
            if (typeof window === "undefined")
                return;
            if (typeof document === "undefined")
                return;
            // Install console + network rings AS EARLY AS POSSIBLE so that by the
            // time the user reports a bug, we already have the recent activity
            // buffered. These hooks are idempotent — safe to call twice.
            installConsoleRing();
            installNetworkRing();
            const widgetOptions = {
                position: options.position ?? "bottom-right",
                buttonLabel: options.buttonLabel ?? "Report visual bug",
                title: options.title ?? "Report a visual bug",
                userEmail: options.userEmail,
                accentColor: options.accentColor,
                hideButton: options.hideButton,
            };
            const mount = () => {
                mountFeedbackWidget(widgetOptions, (payload) => {
                    // Capture rich context AT SUBMIT TIME. The user has typed their
                    // description by now but the page DOM hasn't materially changed
                    // from when they first saw the bug — close enough for V0.
                    //
                    // Wrapped in IIFE because mountFeedbackWidget's callback is sync;
                    // we don't want to delay the widget's own "Thanks" UX on the
                    // network round-trip.
                    void (async () => {
                        try {
                            const bundle = await captureContext();
                            // Allow the host app to intercept (analytics, custom routing).
                            if (options.onSubmit) {
                                const result = await options.onSubmit({
                                    description: payload.description,
                                    email: payload.email,
                                    screenshot: payload.screenshot,
                                    bundle,
                                });
                                if (result === false)
                                    return;
                            }
                            if (!payload.screenshot) {
                                // No screenshot attached — server requires one. Skip upload
                                // silently in V0; V0.5 will surface a UX prompt asking the
                                // user to attach one. The console warn helps integrators
                                // debug while developing.
                                if (config.debug && !config.silent) {
                                    console.warn("[@inariwatch/capture/visual-report] No screenshot attached — skipping upload. " +
                                        "Click the 'Attach screenshot' button before submitting.");
                                }
                                return;
                            }
                            const result = await uploadVisualReport({
                                config,
                                screenshot: payload.screenshot,
                                description: payload.description,
                                email: payload.email,
                                bundle,
                            });
                            if (!result.ok && config.debug && !config.silent) {
                                console.warn("[@inariwatch/capture/visual-report] Upload failed:", result.status, result.error);
                            }
                            options.onUploaded?.(result);
                        }
                        catch (err) {
                            if (config.debug && !config.silent) {
                                console.warn("[@inariwatch/capture/visual-report] submit failed:", err);
                            }
                        }
                    })();
                });
            };
            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", mount, { once: true });
            }
            else {
                mount();
            }
        },
    };
}
//# sourceMappingURL=index.js.map