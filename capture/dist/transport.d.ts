import type { CaptureConfig, ErrorEvent, ParsedDSN } from "./types.js";
/**
 * Project-token prefix introduced in Inari Live V1 — Session 2. Tokens
 * minted by the web app or Inari Live look like `iwk_pub_v1_<…>`. When
 * the parsed `secretKey` matches this prefix, the transport switches
 * from HMAC body signing to `Authorization: Bearer` auth.
 *
 * Kept in sync with `web/lib/services/project-tokens.service.ts` —
 * changing the prefix here without bumping the server is a wire break.
 */
export declare const PROJECT_TOKEN_PREFIX = "iwk_pub_v1_";
export declare function isProjectToken(value: string | null | undefined): boolean;
export declare function parseDSN(dsn: string): ParsedDSN;
/**
 * Resolve a project-token plaintext + projectId into a wire-ready ParsedDSN.
 * Used when the user passes `init({ token, projectId })` instead of a DSN
 * URL — the SDK synthesises the endpoint from `host` / `INARIWATCH_HOST` /
 * the default `https://app.inariwatch.com`. The server treats the token's
 * project_id as authoritative AND verifies the URL path UUID matches as
 * defense-in-depth, so the projectId argument is required.
 *
 * Returns `null` when the token doesn't look like a project token. Caller
 * should fall back to DSN mode (or local mode) in that case. The friction-
 * free path is to use the DSN URL the web mint endpoint already returns
 * (`https://iwk_pub_v1_…@host/capture/<projectId>`) — that has both pieces
 * baked in and just goes through `parseDSN`.
 */
export declare function parseToken(token: string, projectId: string, hostOverride?: string): ParsedDSN | null;
export interface Transport {
    send(event: ErrorEvent): void;
    flush(): Promise<void>;
}
export declare function createLocalTransport(_config: CaptureConfig): Transport;
export declare function createTransport(config: CaptureConfig, parsed: ParsedDSN): Transport;
//# sourceMappingURL=transport.d.ts.map