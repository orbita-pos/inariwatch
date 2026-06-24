/**
 * HMAC-SHA256 signing using the Web Crypto API.
 *
 * Browsers cannot keep secrets safely, so production browser deployments
 * typically use a public, project-scoped DSN that the backend validates by
 * referer / origin instead of HMAC. We still support HMAC for environments
 * (e.g. Electron, code-signed extensions) where the secret is genuinely
 * private. The output format matches the server-side header used by every
 * other SDK: ``sha256=<hex>``.
 */
export declare function signSha256Hex(payload: Uint8Array, secret: string): Promise<string>;
//# sourceMappingURL=hmac.d.ts.map