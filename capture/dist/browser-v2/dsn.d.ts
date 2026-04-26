/**
 * Parses `https://SECRET@host/capture/ID` (and `http://...` for localhost).
 *
 * Returns the same shape every other SDK uses: { url, secret, projectId, isLocal }.
 * The path is normalised to `/api/webhooks/capture/ID` server-side.
 */
export interface ParsedDsn {
    url: string;
    secret: string;
    projectId: string;
    isLocal: boolean;
}
export declare function parseDsn(dsn: string): ParsedDsn;
//# sourceMappingURL=dsn.d.ts.map