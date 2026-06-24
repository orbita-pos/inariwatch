/**
 * Vulnerability detection — when a tainted input reaches a sink,
 * classify the vulnerability and report it via captureException.
 */
import type { SecurityContext, ShieldConfig } from "../types.js";
/** Check a sink argument for tainted input and report if found. */
export declare function inspectSink(sinkName: string, args: unknown[], config: ShieldConfig): SecurityContext | null;
/** Build an error title for a security event. */
export declare function buildSecurityTitle(ctx: SecurityContext): string;
/** Build the error body with full context. */
export declare function buildSecurityBody(ctx: SecurityContext): string;
//# sourceMappingURL=detect.d.ts.map