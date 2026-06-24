/**
 * Integration export for `init({ integrations: [fleetBloomIntegration(...)] })`.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Behavior:
 *   - On `setup()`, kicks off the bloom fetch (fire-and-forget; non-blocking).
 *     The first few events after init may not see the bloom — that's fine,
 *     they ship without `fleetMatch`. Subsequent events get the data.
 *   - On `onBeforeSend()`, attaches `event.fleetMatch = { bloomHit: bool }`
 *     so the server-side enricher (and the peer agent's `matchFingerprint`
 *     tool) have the result without their own RTT.
 *   - When `contribute: true` and the bloom did NOT hit (i.e. likely a new
 *     pattern), POSTs the anonymized fingerprint to the observe endpoint
 *     in the background. Capped at one contribution per fingerprint per
 *     process.
 */
import type { Integration } from "../types.js";
import { type FleetBloomClientOptions } from "./client.js";
export interface FleetBloomIntegrationConfig extends FleetBloomClientOptions {
    /** Send anonymized fingerprint POST when this SDK sees a bloom miss. Default: false. */
    contribute?: boolean;
    /** Optional metadata sent with each contribution. */
    framework?: string;
    language?: string;
}
export declare function fleetBloomIntegration(config?: FleetBloomIntegrationConfig): Integration;
//# sourceMappingURL=integration.d.ts.map