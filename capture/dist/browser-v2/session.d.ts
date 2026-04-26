/**
 * FullTrace session id management.
 *
 * Each browser tab gets a UUID at SDK init time (or reuses one from
 * sessionStorage when running across SPA navigations). The id is sent
 * as ``X-IW-Session-Id`` on every fetch / XHR so the backend can correlate
 * front-end errors to their downstream API calls.
 */
export declare function ensureSessionId(override?: string): string;
export declare function getSessionId(): string | null;
export declare function resetSessionIdForTesting(): void;
//# sourceMappingURL=session.d.ts.map