/**
 * Scope — request context, user context, and tags.
 * Uses AsyncLocalStorage for per-request isolation in Node.js.
 * Falls back to global state in edge runtime.
 */
let asyncStorage = null;
try {
    const { AsyncLocalStorage } = require("node:async_hooks");
    asyncStorage = new AsyncLocalStorage();
}
catch {
    // Edge runtime — fallback to global
}
let globalScope = {};
// Pattern-based: redact any header containing these words
const REDACT_HEADER_PATTERNS = ["token", "key", "secret", "auth", "credential", "password", "cookie", "session"];
function shouldRedactHeader(name) {
    const lower = name.toLowerCase();
    return REDACT_HEADER_PATTERNS.some((p) => lower.includes(p));
}
// Sensitive body fields to redact
const REDACT_BODY_FIELDS = new Set([
    "password", "passwd", "pass", "secret", "token", "api_key", "apiKey",
    "access_token", "accessToken", "refresh_token", "refreshToken",
    "credit_card", "creditCard", "card_number", "cardNumber", "cvv", "cvc",
    "ssn", "social_security", "authorization",
]);
function redactBody(body) {
    if (body === null || body === undefined)
        return body;
    if (typeof body === "string") {
        return body.length > 1024 ? body.slice(0, 1024) + "...[truncated]" : body;
    }
    if (typeof body !== "object")
        return body;
    if (Array.isArray(body))
        return body.slice(0, 20);
    const safe = {};
    const obj = body;
    for (const [k, v] of Object.entries(obj)) {
        if (REDACT_BODY_FIELDS.has(k) || REDACT_BODY_FIELDS.has(k.toLowerCase())) {
            safe[k] = "[REDACTED]";
        }
        else if (typeof v === "string" && v.length > 500) {
            safe[k] = v.slice(0, 500) + "...[truncated]";
        }
        else {
            safe[k] = v;
        }
    }
    return safe;
}
function getScope() {
    if (asyncStorage) {
        return asyncStorage.getStore() ?? globalScope;
    }
    return globalScope;
}
// ── Public API ──────────────────────────────────────────────────────────────
export function setUser(user) {
    // Strip email by default (PII) — only keep id + role
    const safe = { id: user.id, role: user.role };
    const scope = getScope();
    scope.user = safe;
}
export function setTag(key, value) {
    const scope = getScope();
    if (!scope.tags)
        scope.tags = {};
    scope.tags[key] = value;
}
export function setRequestContext(ctx) {
    const scope = getScope();
    // Redact sensitive headers (pattern-based)
    const safeHeaders = {};
    if (ctx.headers) {
        for (const [k, v] of Object.entries(ctx.headers)) {
            safeHeaders[k] = shouldRedactHeader(k) ? "[REDACTED]" : v;
        }
        // Also redact IP-related headers
        for (const h of ["x-forwarded-for", "x-real-ip"]) {
            if (safeHeaders[h])
                safeHeaders[h] = "[REDACTED]";
        }
    }
    scope.requestContext = {
        method: ctx.method,
        url: ctx.url,
        headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined,
        query: ctx.query,
        body: redactBody(ctx.body),
        // IP omitted by default (PII/GDPR) — only sent if explicitly set
    };
}
export function getUser() {
    return getScope().user;
}
export function getTags() {
    return getScope().tags;
}
export function getRequestContext() {
    return getScope().requestContext;
}
/**
 * Run a function with an isolated scope (for per-request isolation).
 * Use in middleware: runWithScope(() => handleRequest(req, res))
 */
export function runWithScope(fn) {
    if (asyncStorage) {
        return asyncStorage.run({}, fn);
    }
    // Edge runtime: clear global scope for this request
    globalScope = {};
    return fn();
}
//# sourceMappingURL=scope.js.map