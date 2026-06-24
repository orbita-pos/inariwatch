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
import { readConsoleRing, readNetworkRing } from "./rings.js";
export async function captureContext(options = {}) {
    const start = performance?.now?.() ?? Date.now();
    const url = stripHashAndSensitiveQuery(location.href);
    const userAgent = (navigator.userAgent ?? "").slice(0, 300);
    const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
    };
    const buildId = readBuildId();
    const focused = captureFocused(options.pointerX, options.pointerY);
    const consoleR = readConsoleRing();
    const networkR = readNetworkRing();
    const webVitals = await readWebVitalsSnapshot();
    const memory = readMemory();
    const bundle = {
        url,
        userAgent,
        viewport,
        buildId,
        capturedAt: Date.now(),
        focused,
        console: consoleR,
        network: networkR,
        captureMs: Math.round((performance?.now?.() ?? Date.now()) - start),
    };
    if (webVitals)
        bundle.webVitals = webVitals;
    if (memory)
        bundle.memory = memory;
    return bundle;
}
// ── Implementations ──────────────────────────────────────────────────────────
function stripHashAndSensitiveQuery(href) {
    try {
        const u = new URL(href);
        u.hash = "";
        const sensitive = /token|auth|secret|key|password|code/i;
        for (const [k] of Array.from(u.searchParams)) {
            if (sensitive.test(k))
                u.searchParams.set(k, "[redacted]");
        }
        return u.toString();
    }
    catch {
        return href.slice(0, 500);
    }
}
function readBuildId() {
    const w = window;
    if (w.__NEXT_DATA__?.buildId)
        return String(w.__NEXT_DATA__.buildId);
    // Generic: <meta name="build-id" content="…">
    const meta = document.querySelector('meta[name="build-id"]');
    if (meta?.content)
        return meta.content;
    const inariBuild = window.__INARI_BUILD_ID__;
    if (typeof inariBuild === "string")
        return inariBuild;
    return null;
}
function captureFocused(x, y) {
    let el = null;
    if (typeof x === "number" && typeof y === "number") {
        el = document.elementFromPoint(x, y);
    }
    if (!el)
        el = document.activeElement;
    if (!el || el === document.body)
        return null;
    const rect = el.getBoundingClientRect();
    const computed = window.getComputedStyle(el);
    const RELEVANT_STYLES = [
        "display", "position", "visibility", "opacity", "z-index", "overflow",
        "width", "height", "max-width", "max-height", "min-width", "min-height",
        "margin", "padding", "border",
        "color", "background-color", "font-size", "font-weight", "line-height",
        "transform", "transition", "animation",
        "pointer-events", "cursor",
    ];
    const styles = {};
    for (const k of RELEVANT_STYLES) {
        const v = computed.getPropertyValue(k);
        if (v)
            styles[k] = v;
    }
    return {
        outerHtml: el.outerHTML.slice(0, 2000),
        selector: buildCssSelector(el),
        styles,
        ax: {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") ?? implicitRole(el),
            name: el.getAttribute("aria-label") ?? truncate(el.textContent ?? "", 80),
            disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        },
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };
}
function buildCssSelector(el) {
    // Pragmatic short-form unique selector. Walks up at most 6 ancestors
    // and prefers id → class → :nth-of-type. Good enough to identify the
    // element in a manual DevTools session; not guaranteed unique across
    // dynamic DOMs (the AI gets the outerHTML for tiebreaking).
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
        if (cur.id) {
            parts.unshift(`#${cssEscape(cur.id)}`);
            break;
        }
        let part = cur.tagName.toLowerCase();
        const cls = (cur.className && typeof cur.className === "string")
            ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
            : [];
        if (cls.length)
            part += "." + cls.map(cssEscape).join(".");
        const parent = cur.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
            if (siblings.length > 1) {
                const idx = siblings.indexOf(cur) + 1;
                part += `:nth-of-type(${idx})`;
            }
        }
        parts.unshift(part);
        cur = cur.parentElement;
        depth++;
    }
    return parts.join(" > ");
}
function cssEscape(s) {
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}
function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "button")
        return "button";
    if (tag === "a")
        return "link";
    if (tag === "input") {
        const type = el.type;
        if (type === "checkbox")
            return "checkbox";
        if (type === "radio")
            return "radio";
        if (type === "submit" || type === "button")
            return "button";
        return "textbox";
    }
    if (tag === "select")
        return "combobox";
    if (tag === "textarea")
        return "textbox";
    return null;
}
function truncate(s, n) {
    s = s.trim().replace(/\s+/g, " ");
    return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
async function readWebVitalsSnapshot() {
    const w = window;
    if (w.__INARI_WEB_VITALS__) {
        const v = w.__INARI_WEB_VITALS__;
        const out = {};
        if (typeof v.lcp === "number")
            out.lcp = v.lcp;
        if (typeof v.cls === "number")
            out.cls = v.cls;
        if (typeof v.inp === "number")
            out.inp = v.inp;
        if (typeof v.fcp === "number")
            out.fcp = v.fcp;
        if (typeof v.ttfb === "number")
            out.ttfb = v.ttfb;
        return Object.keys(out).length ? out : undefined;
    }
    return undefined;
}
function readMemory() {
    const perf = performance;
    if (perf.memory && typeof perf.memory.usedJSHeapSize === "number") {
        return {
            used: perf.memory.usedJSHeapSize,
            total: perf.memory.totalJSHeapSize,
            limit: perf.memory.jsHeapSizeLimit,
        };
    }
    return undefined;
}
//# sourceMappingURL=capture-context.js.map