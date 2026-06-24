/**
 * Side-effect import — call init() automatically using DSN from:
 *   - window.__INARIWATCH__.dsn
 *   - <meta name="inariwatch:dsn" content="...">
 *
 * Used as ``import "@inariwatch/capture-browser/auto"``.
 */
import { init } from "./client.js";
function autoInit() {
    if (typeof window === "undefined")
        return;
    let dsn = window.__INARIWATCH__?.dsn;
    let environment = window.__INARIWATCH__?.environment;
    let release = window.__INARIWATCH__?.release;
    if (!dsn && typeof document !== "undefined") {
        const meta = document.querySelector('meta[name="inariwatch:dsn"]');
        if (meta)
            dsn = meta.content;
        const envMeta = document.querySelector('meta[name="inariwatch:environment"]');
        if (envMeta)
            environment = envMeta.content;
        const relMeta = document.querySelector('meta[name="inariwatch:release"]');
        if (relMeta)
            release = relMeta.content;
    }
    init({ dsn, environment, release });
}
autoInit();
//# sourceMappingURL=auto.js.map