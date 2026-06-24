import { captureLog } from "../client.js";
import { elSelector, getPathname } from "./utils.js";
const MODERN_FORMATS = [".webp", ".avif"];
const LEGACY_PATTERN = /\.(jpe?g|png|gif|bmp|tiff?)(\?.*)?$/i;
const OVERSIZED_RATIO = 2; // natural width > 2× rendered width
function hasModernFormat(src) {
    try {
        const path = new URL(src, location.href).pathname.toLowerCase();
        if (MODERN_FORMATS.some(ext => path.endsWith(ext)))
            return true;
        // Also accept CDN transform params like ?fm=webp, ?format=webp, ?auto=format
        const url = new URL(src, location.href);
        const params = url.searchParams;
        const fmt = params.get("fm") ?? params.get("format") ?? params.get("f");
        if (fmt && MODERN_FORMATS.includes(`.${fmt}`))
            return true;
        const auto = params.get("auto");
        if (auto === "format" || auto === "webp")
            return true;
    }
    catch {
        // Relative URL or data URI — skip format check
    }
    return false;
}
function isBelowFold(el) {
    try {
        const rect = el.getBoundingClientRect();
        return rect.top > window.innerHeight;
    }
    catch {
        return false;
    }
}
export function scanImages(config) {
    if (typeof window === "undefined")
        return;
    const pathname = getPathname(config);
    const issues = [];
    const images = document.querySelectorAll("img");
    for (const img of images) {
        if (!img.src || img.src.startsWith("data:"))
            continue;
        const selector = elSelector(img);
        // 1. Missing loading="lazy" on below-fold images
        if (isBelowFold(img) && img.loading !== "lazy") {
            issues.push({
                type: "missing_lazy",
                src: img.src,
                element: selector,
            });
        }
        // 2. Missing width/height — causes CLS on load
        const hasWidthAttr = img.hasAttribute("width") || img.hasAttribute("height");
        const hasStyleDims = img.style.width || img.style.height;
        if (!hasWidthAttr && !hasStyleDims && img.naturalWidth > 0) {
            issues.push({
                type: "missing_dimensions",
                src: img.src,
                element: selector,
            });
        }
        // 3. Oversized: intrinsic size > 2× rendered size
        if (img.naturalWidth > 0 &&
            img.offsetWidth > 0 &&
            img.naturalWidth > img.offsetWidth * OVERSIZED_RATIO) {
            issues.push({
                type: "oversized_ratio",
                src: img.src,
                element: selector,
                detail: {
                    naturalPx: img.naturalWidth,
                    renderedPx: img.offsetWidth,
                    ratio: Math.round((img.naturalWidth / img.offsetWidth) * 10) / 10,
                },
            });
        }
        // 4. Non-modern format (JPEG/PNG/GIF when WebP/AVIF is available)
        if (LEGACY_PATTERN.test(img.src) && !hasModernFormat(img.src)) {
            issues.push({
                type: "non_modern_format",
                src: img.src,
                element: selector,
                detail: { suggestion: "Convert to WebP or AVIF for 25-50% smaller files" },
            });
        }
    }
    if (issues.length === 0)
        return;
    const grouped = issues.reduce((acc, i) => {
        acc[i.type] = (acc[i.type] ?? 0) + 1;
        return acc;
    }, {});
    captureLog(`image_optimization: ${issues.length} ${issues.length === 1 ? "opportunity" : "opportunities"} on ${pathname ?? location.pathname}`, "info", {
        kind: "image_optimization",
        issueCount: issues.length,
        imageCount: images.length,
        byType: grouped,
        issues: issues.slice(0, 20), // cap payload
        pathname,
    });
}
//# sourceMappingURL=image-optimizer.js.map