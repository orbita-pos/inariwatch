/**
 * POST a visual report to /api/capture/user-report/[projectId].
 *
 * Resolves the endpoint from (in order):
 *   1. config.host           (explicit override)
 *   2. config.dsn            (parsed for host + token + projectId)
 *   3. INARIWATCH_HOST       (env var)
 *   4. https://app.inariwatch.com (default)
 *
 * Token resolution:
 *   1. config.token
 *   2. parsed from DSN userInfo
 *   3. INARIWATCH_TOKEN env var
 *
 * projectId resolution:
 *   1. config.projectId
 *   2. parsed from DSN path
 *   3. INARIWATCH_PROJECT_ID env var
 *
 * Without a token AND a projectId the upload is a no-op (returns ok: false).
 * The integration logs a warning to console when debug is enabled.
 */
const DEFAULT_HOST = "https://app.inariwatch.com";
const TOKEN_PREFIX = "iwk_pub_v1_";
export async function uploadVisualReport(input) {
    const env = readEnv();
    const { token, projectId, host } = resolveAuth(input.config, env);
    if (!token) {
        return { ok: false, error: "No project token configured (set INARIWATCH_TOKEN or pass config.token)" };
    }
    if (!projectId) {
        return { ok: false, error: "No projectId configured (pass config.projectId or use a DSN URL)" };
    }
    const endpoint = `${host.replace(/\/$/, "")}/api/capture/user-report/${projectId}`;
    // Compose description: append the email if the widget collected one. The
    // backend treats description as free-form text.
    const description = input.email
        ? `${input.description}\n\n— Reporter: ${input.email}`
        : input.description;
    const body = JSON.stringify({
        screenshot: input.screenshot,
        bundle: input.bundle,
        description: description.slice(0, 1000),
        captureMs: input.bundle.captureMs,
        payloadSize: undefined, // server measures actual bytes
    });
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
            },
            body,
            // Keep-alive so submits land even when the user navigates away mid-send.
            keepalive: body.length < 60000, // browser keepalive cap
        });
        if (!res.ok) {
            const errBody = await safeReadText(res);
            return { ok: false, status: res.status, error: errBody || res.statusText };
        }
        const json = await res.json();
        return {
            ok: json.ok !== false,
            status: res.status,
            reportId: json.reportId,
            alertId: json.alertId,
        };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function readEnv() {
    if (typeof process === "undefined" || !process.env)
        return {};
    const e = process.env;
    return {
        HOST: e.INARIWATCH_HOST,
        TOKEN: e.INARIWATCH_TOKEN,
        PROJECT_ID: e.INARIWATCH_PROJECT_ID ?? e.NEXT_PUBLIC_INARIWATCH_PROJECT_ID,
    };
}
function resolveAuth(config, env) {
    // DSN URL: "https://<secret-or-token>@<host>/capture/<projectId>"
    // We accept either shape and pluck the pieces we need.
    let dsnHost = null;
    let dsnToken = null;
    let dsnProjectId = null;
    if (config.dsn) {
        try {
            const u = new URL(config.dsn);
            dsnHost = `${u.protocol}//${u.host}`;
            // userInfo holds either a legacy HMAC secret or the new project token.
            if (u.username)
                dsnToken = decodeURIComponent(u.username);
            // Path is /capture/<projectId> (token mode) OR /capture/<integrationId> (legacy).
            // For visual reports we only support token mode.
            const match = u.pathname.match(/\/capture\/([0-9a-f-]{36})/i);
            if (match)
                dsnProjectId = match[1];
        }
        catch {
            // Malformed DSN — fall through to other resolvers.
        }
    }
    const host = config.host
        ?? dsnHost
        ?? env.HOST
        ?? DEFAULT_HOST;
    const token = config.token
        ?? (dsnToken && dsnToken.startsWith(TOKEN_PREFIX) ? dsnToken : null)
        ?? env.TOKEN
        ?? null;
    const projectId = config.projectId
        ?? dsnProjectId
        ?? env.PROJECT_ID
        ?? null;
    return { token, projectId, host };
}
async function safeReadText(res) {
    try {
        const txt = await res.text();
        return txt.slice(0, 200);
    }
    catch {
        return "";
    }
}
//# sourceMappingURL=upload.js.map