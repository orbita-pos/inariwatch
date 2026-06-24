/**
 * Side-effect import — call init() automatically using DSN from:
 *   - window.__INARIWATCH__.dsn
 *   - <meta name="inariwatch:dsn" content="...">
 *
 * Used as ``import "@inariwatch/capture-browser/auto"``.
 */
declare global {
    interface Window {
        __INARIWATCH__?: {
            dsn?: string;
            environment?: string;
            release?: string;
        };
    }
}
export {};
//# sourceMappingURL=auto.d.ts.map