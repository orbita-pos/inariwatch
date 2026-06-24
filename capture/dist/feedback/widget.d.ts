/**
 * Zero-dep feedback widget. Renders a floating button + modal into the DOM,
 * collects user report, and returns the payload for the integration to send.
 *
 * Styles are inlined to avoid leaking into the host app's CSS namespace.
 * Every element gets a `data-inariwatch-feedback` attribute so users who
 * want to customize can target it via CSS.
 */
export interface WidgetOptions {
    /** Placement of the floating button. Default: "bottom-right". */
    position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
    /** Button label. Default: "Report a bug". */
    buttonLabel?: string;
    /** Modal title. Default: "Report a bug". */
    title?: string;
    /** Pre-fill email field if the host app knows the user. */
    userEmail?: string;
    /** Accent color for the primary button. Default: InariWatch orange. */
    accentColor?: string;
    /** Hide the floating button (useful if host app renders its own trigger). */
    hideButton?: boolean;
}
export interface FeedbackPayload {
    description: string;
    email: string;
    /** Optional dataURL if the user chose to attach a screenshot. */
    screenshot?: string;
    /** Page URL where feedback was captured. */
    url: string;
    userAgent: string;
    /** Viewport size at capture time — helps correlate layout bugs. */
    viewport: {
        width: number;
        height: number;
    };
}
type Handler = (payload: FeedbackPayload) => void;
export declare function mountFeedbackWidget(options: WidgetOptions, onSubmit: Handler): () => void;
export {};
//# sourceMappingURL=widget.d.ts.map