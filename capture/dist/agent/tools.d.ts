/**
 * Local tools the peer agent can invoke at diagnose time.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.3.
 *
 * All tools are in-process (no network) so the agent loop stays under the
 * 1.5s deadline. Network-bound work (OpenAI call) lives in `agent.ts`.
 *
 * The 4 tools mirror the SKYNET_MASTER_PLAN §3 spec:
 *   1. getLocalsAtFrame      — pulls locals out of `event.forensics`
 *   2. evaluateInFrame       — sandboxed `inspector.Session` post-mortem eval
 *   3. matchFingerprint      — checks the SDK's local SQLite cache (or
 *                              event.fleetMatch when bloom integration ran)
 *   4. diffSinceDeploy       — emits `git log` between `event.git.commit`
 *                              and the prior deploy SHA stored in env
 */
import type { ErrorEvent, SerializedValue } from "../types.js";
export interface ToolErrorResult {
    ok: false;
    error: string;
}
export interface GetLocalsResult {
    ok: true;
    frameIndex: number;
    locals: Record<string, SerializedValue>;
}
export interface EvaluateInFrameResult {
    ok: true;
    frameIndex: number;
    expression: string;
    value: SerializedValue;
}
export interface MatchFingerprintResult {
    ok: true;
    fingerprint: string;
    match: {
        bloomHit: boolean;
        communityFixId?: string;
        teamsHit?: number;
    } | null;
}
export interface DiffSinceDeployResult {
    ok: true;
    fromSha: string;
    toSha: string | null;
    diff: string;
}
export type ToolResult = GetLocalsResult | EvaluateInFrameResult | MatchFingerprintResult | DiffSinceDeployResult | ToolErrorResult;
export declare function getLocalsAtFrame(event: ErrorEvent, frameIndex: number): GetLocalsResult | ToolErrorResult;
/**
 * Sandboxed eval against an inspector.Session-captured frame.
 *
 * This is intentionally a stub in the v0.1 release: the underlying
 * post-mortem eval requires the `@inariwatch/node-forensic` package's
 * Session to still be attached when the tool fires, which only holds when
 * the agent runs synchronously after the throw. Async agent loops that
 * cross task boundaries lose the stack frames.
 *
 * For v0.1 we surface a structured "unsupported" result so the agent
 * learns not to call this tool, instead of throwing. The stub will be
 * replaced with the real impl when capture-forensic ships its
 * `evalInFrame()` export. Tracked under SKYNET_MASTER_PLAN §3 #2.
 */
export declare function evaluateInFrame(_event: ErrorEvent, _frameIndex: number, _expression: string): EvaluateInFrameResult | ToolErrorResult;
export declare function matchFingerprint(event: ErrorEvent, fingerprint: string): MatchFingerprintResult;
/**
 * Emits a compact summary of git activity between the deploy that's
 * throwing and the prior known-good deploy. Source-of-truth for the prior
 * SHA is the `INARIWATCH_PRIOR_DEPLOY_SHA` env var, written by the deploy
 * script (e.g. Vercel's `pre-deploy` hook). Without it, we return a
 * structured "unknown" result rather than guessing.
 *
 * This deliberately does NOT shell out to `git log` from the SDK — most
 * production processes don't have a repo on disk. Instead, we rely on
 * `event.git.commit` (sent by the SDK, populated at build time) and the
 * env hint. Server-side enrichers can fetch the actual diff later.
 */
export declare function diffSinceDeploy(event: ErrorEvent): DiffSinceDeployResult | ToolErrorResult;
/** OpenAI-style tool schema descriptor. */
export interface ToolSchema {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, {
            type: string;
            description: string;
        }>;
        required: string[];
    };
}
export declare const TOOL_SCHEMAS: ToolSchema[];
//# sourceMappingURL=tools.d.ts.map