import { computeErrorFingerprint } from "./fingerprint.js";
import { parseDSN, createTransport, createLocalTransport } from "./transport.js";
import { getGitContext } from "./git.js";
import { getEnvironmentContext } from "./environment.js";
import { getBreadcrumbs, initBreadcrumbs } from "./breadcrumbs.js";
import { getUser, getTags, getRequestContext } from "./scope.js";
let globalTransport = null;
let globalConfig = null;
let lastReportedRelease = null;
let substrateFlush = null;
let sessionFlush = null;
/** Flush all pending events — call this before process exit or serverless return. */
export async function flush() {
    if (globalTransport)
        await globalTransport.flush();
}
export function init(config = {}) {
    const env = typeof process !== "undefined" && process.env ? process.env : {};
    const dsn = config.dsn || env.INARIWATCH_DSN;
    const environment = config.environment || env.INARIWATCH_ENVIRONMENT || env.NODE_ENV;
    globalConfig = { ...config, dsn, environment };
    if (!dsn) {
        globalTransport = createLocalTransport(globalConfig);
        if (!config.silent) {
            console.log("\x1b[2m[@inariwatch/capture] Local mode — errors print to terminal. Set INARIWATCH_DSN to send to cloud.\x1b[0m");
        }
    }
    else {
        const parsed = parseDSN(dsn);
        globalTransport = createTransport(globalConfig, parsed);
    }
    // Initialize breadcrumbs (auto-intercept console + fetch)
    initBreadcrumbs();
    // Report deploy if release is set
    if (config.release && config.release !== lastReportedRelease) {
        lastReportedRelease = config.release;
        reportDeploy(config.release, config.environment);
    }
    // Activate Substrate I/O recording if enabled
    if (config.substrate) {
        const subConfig = typeof config.substrate === "object" ? config.substrate : {};
        initSubstrate(subConfig, config);
    }
    // Activate browser session recording if enabled
    if (config.session) {
        const sesConfig = typeof config.session === "object" ? config.session : {};
        import("./session.js").then(({ initSession, getSessionEvents }) => {
            initSession(sesConfig, config);
            sessionFlush = getSessionEvents;
        }).catch(() => {
            // session.ts uses dynamic import of rrweb — errors handled there
        });
    }
}
async function initSubstrate(subConfig, config) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pkg = "@inariwatch/substrate-agent";
        const agent = await import(/* webpackIgnore: true */ pkg);
        agent.init({
            bufferSeconds: subConfig.bufferSeconds ?? 60,
            ...(subConfig.redact ? { redact: subConfig.redact } : {}),
        });
        substrateFlush = agent.flush;
        if (!config.silent) {
            const debug = config.debug ? console.warn : () => { };
            debug("[@inariwatch/capture] Substrate recording active (ring buffer)");
        }
    }
    catch {
        if (!config.silent) {
            console.warn("[@inariwatch/capture] substrate: true but @inariwatch/substrate-agent not installed. Run: npm install @inariwatch/substrate-agent");
        }
    }
}
function reportDeploy(release, environment) {
    if (!globalTransport || !globalConfig)
        return;
    const transport = globalTransport;
    const config = globalConfig;
    computeErrorFingerprint(`deploy:${release}`, environment || "").then((fp) => {
        const event = {
            fingerprint: fp,
            title: `Deploy: ${release}`,
            body: `New release deployed: ${release}${environment ? ` (${environment})` : ""}`,
            severity: "info",
            timestamp: new Date().toISOString(),
            environment: config.environment,
            release,
            eventType: "deploy",
        };
        transport.send(event);
    });
}
/** Enrich event with git, env, breadcrumbs, user, tags, request context */
function enrichEvent(event) {
    return {
        ...event,
        git: getGitContext() ?? undefined,
        env: getEnvironmentContext(),
        breadcrumbs: getBreadcrumbs(),
        user: getUser(),
        tags: getTags(),
        request: getRequestContext() ?? event.request,
    };
}
export function captureException(error, context) {
    if (!globalTransport || !globalConfig)
        return;
    const title = `${error.name}: ${error.message}`;
    const body = error.stack || title;
    const event = {
        title,
        body,
        severity: "critical",
        timestamp: new Date().toISOString(),
        environment: globalConfig.environment,
        release: globalConfig.release,
        context,
        request: context?.request,
        runtime: context?.runtime,
        routePath: context?.routePath,
        routeType: context?.routeType,
    };
    const transport = globalTransport;
    const config = globalConfig;
    computeErrorFingerprint(title, body).then((fp) => {
        const fullEvent = enrichEvent({ ...event, fingerprint: fp });
        // Attach session recording if available (before send)
        if (sessionFlush) {
            fullEvent.sessionEvents = sessionFlush();
        }
        if (config.beforeSend) {
            const filtered = config.beforeSend(fullEvent);
            if (!filtered)
                return;
            transport.send(filtered);
        }
        else {
            transport.send(fullEvent);
        }
        if (substrateFlush && config.dsn) {
            // Upload substrate recording to InariWatch alongside the error
            const uploadUrl = config.dsn.replace(/\/capture\//, "/api/recordings/upload/");
            substrateFlush(uploadUrl).catch(() => { });
        }
    });
}
export function captureMessage(message, level = "info") {
    if (!globalTransport || !globalConfig)
        return;
    const transport = globalTransport;
    const config = globalConfig;
    computeErrorFingerprint(message, "").then((fp) => {
        const event = enrichEvent({
            fingerprint: fp,
            title: message,
            body: message,
            severity: level,
            timestamp: new Date().toISOString(),
            environment: config.environment,
            release: config.release,
        });
        if (config.beforeSend) {
            const filtered = config.beforeSend(event);
            if (!filtered)
                return;
            transport.send(filtered);
        }
        else {
            transport.send(event);
        }
    });
}
const LOG_SEVERITY_MAP = {
    fatal: "critical",
    error: "critical",
    warn: "warning",
    info: "info",
    debug: "info",
};
export function captureLog(message, level = "info", metadata) {
    if (!globalTransport || !globalConfig)
        return;
    const transport = globalTransport;
    const config = globalConfig;
    computeErrorFingerprint(`log:${level}:${message}`, "").then((fp) => {
        const event = enrichEvent({
            fingerprint: fp,
            title: `[${level.toUpperCase()}] ${message}`,
            body: metadata ? `${message}\n\n${JSON.stringify(metadata, null, 2)}` : message,
            severity: LOG_SEVERITY_MAP[level] || "info",
            timestamp: new Date().toISOString(),
            environment: config.environment,
            release: config.release,
            eventType: "log",
            logLevel: level,
            metadata,
        });
        if (config.beforeSend) {
            const filtered = config.beforeSend(event);
            if (!filtered)
                return;
            transport.send(filtered);
        }
        else {
            transport.send(event);
        }
    });
}
//# sourceMappingURL=client.js.map