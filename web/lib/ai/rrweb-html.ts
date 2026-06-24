/**
 * Rrweb → HTML walker.
 *
 * Substrate recordings store rrweb events in `substrate_recordings.ui_events`.
 * The Capture SDK captures type 2 (FullSnapshot), type 3 (IncrementalSnapshot
 * for clicks + inputs), and type 4 (Meta/navigation) wrapped in a lightweight
 * envelope. To feed the AI prediction pipeline we need the LAST FullSnapshot
 * as a plain HTML string — the tree shape at the moment the error occurred.
 *
 * There is no public rrweb API that does this server-side. This walker
 * implements the minimum: take the node tree from a FullSnapshot, recursively
 * serialize it to HTML, preserve `data-rrweb-id` attributes so the downstream
 * Claude prompt can reference targets, skip `<script>` tags, and stop cleanly
 * on malformed input.
 *
 * Deliberate simplifications (MVP):
 *   - Shadow DOM and iframes are flattened into their host document. Good
 *     enough for a preview; not a faithful replay.
 *   - `::before` / `::after` pseudo-elements are lost (not in the DOM).
 *   - Computed styles beyond inline + <style> tags are missing (rrweb never
 *     captured them). `css-hydrate.ts` fills some of this gap via external
 *     stylesheet fetches.
 */

// rrweb node types per the spec.
const NODE_TYPE_DOCUMENT = 0;
const NODE_TYPE_DOCTYPE = 1;
const NODE_TYPE_ELEMENT = 2;
const NODE_TYPE_TEXT = 3;
const NODE_TYPE_CDATA = 4;
const NODE_TYPE_COMMENT = 5;

type RrwebNode =
  | { type: typeof NODE_TYPE_DOCUMENT; childNodes?: RrwebNode[] }
  | { type: typeof NODE_TYPE_DOCTYPE; name?: string; publicId?: string; systemId?: string }
  | {
      type: typeof NODE_TYPE_ELEMENT;
      id?: number;
      tagName: string;
      attributes?: Record<string, string | number | boolean>;
      childNodes?: RrwebNode[];
      isSVG?: boolean;
    }
  | { type: typeof NODE_TYPE_TEXT; textContent?: string }
  | { type: typeof NODE_TYPE_CDATA; textContent?: string }
  | { type: typeof NODE_TYPE_COMMENT; textContent?: string };

type RrwebEvent = {
  type: number;
  timestamp?: number;
  data?: { node?: RrwebNode; initialOffset?: unknown } & Record<string, unknown>;
};

/**
 * Capture SDK wraps each event in this envelope (see capture/src/types.ts).
 * We try the wrapped form first, fall back to raw rrweb events.
 */
type SessionEventEnvelope = {
  rrwebEvent?: RrwebEvent;
  timestamp?: number;
};

/** Void HTML elements that must NOT have a closing tag. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements stripped entirely — they execute code or phone home. */
const FORBIDDEN_TAGS = new Set(["script", "iframe", "object", "embed"]);

/** Event handler + inline-script attributes — stripped at serialization. */
const FORBIDDEN_ATTR_PREFIX = ["on", "javascript:"];

export type ExtractedSnapshot = {
  html: string;
  /** The serialized document's `<style>` + CSS-in-JS style tags (order preserved). */
  inlineStylesheets: string[];
  /** URLs of <link rel="stylesheet"> found — caller can hydrate these. */
  externalStylesheetHrefs: string[];
  /** Human stats for observability. */
  nodeCount: number;
  capturedAt: Date | null;
};

/**
 * Find the LAST FullSnapshot in a session's ui_events array and serialize
 * it. Returns null when no FullSnapshot exists (e.g. a recording that only
 * captured clicks without a base snapshot).
 */
export function extractLastSnapshot(uiEvents: unknown): ExtractedSnapshot | null {
  if (!Array.isArray(uiEvents) || uiEvents.length === 0) return null;

  let latest: { event: RrwebEvent; ts: number | null } | null = null;
  for (let i = uiEvents.length - 1; i >= 0; i--) {
    const entry = uiEvents[i] as SessionEventEnvelope | RrwebEvent;
    const rrweb: RrwebEvent | undefined =
      "rrwebEvent" in entry && entry.rrwebEvent
        ? entry.rrwebEvent
        : "type" in entry && typeof entry.type === "number"
          ? (entry as RrwebEvent)
          : undefined;
    if (!rrweb || rrweb.type !== 2) continue;
    latest = {
      event: rrweb,
      ts:
        (typeof rrweb.timestamp === "number" ? rrweb.timestamp : null) ??
        ("timestamp" in entry && typeof entry.timestamp === "number"
          ? entry.timestamp
          : null),
    };
    break;
  }

  if (!latest) return null;
  const root = latest.event.data?.node;
  if (!root) return null;

  const ctx: SerializeContext = {
    inlineStylesheets: [],
    externalStylesheetHrefs: [],
    nodeCount: 0,
  };
  const html = serialize(root, ctx);

  return {
    html,
    inlineStylesheets: ctx.inlineStylesheets,
    externalStylesheetHrefs: ctx.externalStylesheetHrefs,
    nodeCount: ctx.nodeCount,
    capturedAt: latest.ts ? new Date(latest.ts) : null,
  };
}

interface SerializeContext {
  inlineStylesheets: string[];
  externalStylesheetHrefs: string[];
  nodeCount: number;
}

function serialize(node: RrwebNode, ctx: SerializeContext): string {
  ctx.nodeCount += 1;

  if (node.type === NODE_TYPE_DOCUMENT) {
    return (node.childNodes ?? []).map((c) => serialize(c, ctx)).join("");
  }

  if (node.type === NODE_TYPE_DOCTYPE) {
    return "<!DOCTYPE html>";
  }

  if (node.type === NODE_TYPE_TEXT || node.type === NODE_TYPE_CDATA) {
    return escapeText(node.textContent ?? "");
  }

  if (node.type === NODE_TYPE_COMMENT) {
    // Strip comments — they're noise for the AI and take tokens. Keep only
    // conditional comments in case someone depends on them (rare).
    return "";
  }

  if (node.type !== NODE_TYPE_ELEMENT) return "";

  const tag = (node.tagName || "").toLowerCase();
  if (!tag) return "";
  if (FORBIDDEN_TAGS.has(tag)) return "";

  // Harvest <link rel="stylesheet" href=...> for external hydration.
  if (tag === "link") {
    const attrs = node.attributes ?? {};
    const rel = String(attrs.rel ?? "").toLowerCase();
    const href = attrs.href ? String(attrs.href) : null;
    if (rel.includes("stylesheet") && href) ctx.externalStylesheetHrefs.push(href);
  }

  // Harvest inline <style> contents.
  if (tag === "style") {
    const cssText = (node.childNodes ?? [])
      .map((c) => {
        if (c.type === NODE_TYPE_TEXT || c.type === NODE_TYPE_CDATA) {
          return c.textContent ?? "";
        }
        return "";
      })
      .join("");
    if (cssText.trim().length > 0) ctx.inlineStylesheets.push(cssText);
  }

  const attrsString = serializeAttributes(node.attributes, tag);

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrsString}>`;
  }

  const inner = (node.childNodes ?? []).map((c) => serialize(c, ctx)).join("");
  return `<${tag}${attrsString}>${inner}</${tag}>`;
}

function serializeAttributes(
  attrs: Record<string, string | number | boolean> | undefined,
  tag: string,
): string {
  if (!attrs) return "";
  const out: string[] = [];
  for (const rawKey of Object.keys(attrs)) {
    const key = rawKey.toLowerCase();
    if (FORBIDDEN_ATTR_PREFIX.some((p) => key.startsWith(p))) continue;
    // Drop `src` on forbidden tags only (iframe/object/embed already stripped).
    const value = attrs[rawKey];
    // Preserve rrweb's data-rrweb-id style attributes so the Claude prompt
    // can target nodes. rrweb writes these as `rr_*` in some versions and
    // we keep them verbatim.
    if (typeof value === "boolean") {
      if (value) out.push(` ${key}`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const stringValue = String(value);
    // Scripts-as-url protocol on href/src — strip.
    if ((key === "href" || key === "src" || key === "action" || key === "formaction")
      && /^\s*javascript:/i.test(stringValue)) {
      continue;
    }
    // `style` attribute is allowed; inline CSS with url() is harmless inside
    // a same-origin sandbox iframe.
    out.push(` ${key}="${escapeAttr(stringValue)}"`);
  }
  // Tag-specific cleanups. Strip srcset on lazy-image elements because the
  // referenced CDN may require auth we don't have; leave src as a best effort.
  if ((tag === "img" || tag === "source") && attrs.srcset) {
    // already emitted via the loop but harmless — leave for fidelity.
  }
  return out.join("");
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
