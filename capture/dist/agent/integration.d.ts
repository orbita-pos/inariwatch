/**
 * Integration export — the surface end users actually consume.
 *
 *   import { init } from "../types.js"
 *   import { peerAgentIntegration } from "@inariwatch/capture-agent"
 *
 *   init({
 *     dsn: process.env.INARIWATCH_DSN,
 *     integrations: [
 *       peerAgentIntegration({ apiKey: process.env.OPENAI_API_KEY! }),
 *     ],
 *   })
 *
 * The integration:
 *   - Reads the env var INARIWATCH_PEER_AGENT_DISABLED — if "true", it
 *     no-ops cleanly (lets users disable the peer in CI without changing
 *     code).
 *   - Lazily constructs PeerAgent on first use (saves init time).
 *   - On `onBeforeSend`, races the agent's `diagnose()` against the
 *     deadline. On success, attaches `event.hypotheses[]`. On failure /
 *     timeout, returns the event unchanged. NEVER drops the event.
 */
import type { Integration } from "../types.js";
import { type PeerAgentConfig } from "./agent.js";
export interface PeerAgentIntegrationConfig extends PeerAgentConfig {
    /**
     * Skip diagnose for events whose severity is below this threshold.
     * Default: "warning". Critical-only would set "critical". Set "info"
     * to diagnose all events including logs (expensive, not recommended).
     */
    minSeverity?: "info" | "warning" | "critical";
}
/**
 * Plugin contract for `init({ integrations: [...] })`. See
 * capture/src/types.ts Integration interface.
 */
export declare function peerAgentIntegration(config: PeerAgentIntegrationConfig): Integration;
//# sourceMappingURL=integration.d.ts.map