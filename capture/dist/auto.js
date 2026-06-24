import { init } from "./client.js";
function warn(ctx, msg, err) {
    if (!ctx.debug)
        return;
    console.warn(`[@inariwatch/capture] ${msg}`, err instanceof Error ? err.message : err ?? "");
}
async function loadAgent(ctx) {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.INARIWATCH_PEER_AGENT_API_KEY;
    if (!apiKey) {
        warn(ctx, "v2 agent: OPENAI_API_KEY not set, skipping");
        return null;
    }
    try {
        const mod = await import("./agent/index.js");
        return mod.peerAgentIntegration?.({
            apiKey,
            model: process.env.INARIWATCH_PEER_AGENT_MODEL,
            baseUrl: process.env.INARIWATCH_PEER_AGENT_BASE_URL,
        }) ?? null;
    }
    catch (err) {
        warn(ctx, "v2 agent failed to load", err);
        return null;
    }
}
async function loadFleet(ctx) {
    try {
        const mod = await import("./fleet/index.js");
        return mod.fleetBloomIntegration?.({
            baseUrl: process.env.INARIWATCH_FLEET_BASE_URL,
            contribute: process.env.INARIWATCH_FLEET_CONTRIBUTE === "true",
        }) ?? null;
    }
    catch (err) {
        warn(ctx, "v2 fleet failed to load", err);
        return null;
    }
}
async function loadForensic(ctx) {
    try {
        const mod = await import("./forensic/index.js");
        return mod.forensicIntegration?.() ?? null;
    }
    catch (err) {
        warn(ctx, "v2 forensic failed to load", err);
        return null;
    }
}
async function loadV2Integrations() {
    const ctx = { debug: process.env.INARIWATCH_DEBUG === "1" };
    const xs = await Promise.all([loadForensic(ctx), loadFleet(ctx), loadAgent(ctx)]);
    return xs.filter((x) => x !== null);
}
// In-process PII / secret redaction (v0.3 S6). Opt-in via env var so the
// auto-init path stays config-free for consumers that do `import "@inariwatch/capture/auto"`
// without ever touching `init()` directly. Accepts "true"/"1"/"yes" to flip on.
const redactFlag = process.env.INARIWATCH_REDACT;
const redactEnabled = redactFlag === "true" || redactFlag === "1" || redactFlag === "yes";
const baseConfig = {
    release: process.env.INARIWATCH_RELEASE,
    substrate: process.env.INARIWATCH_SUBSTRATE === "true",
    redact: redactEnabled,
};
const v2Flag = process.env.INARIWATCH_CAPTURE_V2;
const v2Enabled = v2Flag === "true" || v2Flag === "1" || v2Flag === "yes";
let integrations = [];
if (v2Enabled) {
    // Top-level await: the integrations are now in-package, so dynamic
    // import resolves sub-ms when the flag is on, and is never reached
    // when the flag is off — bundlers tree-shake the agent/fleet/forensic
    // dirs out entirely for non-opt-in users.
    integrations = await loadV2Integrations();
}
init({ ...baseConfig, integrations });
//# sourceMappingURL=auto.js.map