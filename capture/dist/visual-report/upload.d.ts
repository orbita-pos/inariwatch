/**
 * POST a visual report to /api/capture/user-report/[projectId].
 *
 * Resolves the endpoint from (in order):
 *   1. config.host           (explicit override)
 *   2. config.dsn            (parsed for host + token + projectId)
 *   3. INARIWATCH_HOST       (env var)
 *   4. https://app.inariwatch.com (default)
 *
 * Token resolution:
 *   1. config.token
 *   2. parsed from DSN userInfo
 *   3. INARIWATCH_TOKEN env var
 *
 * projectId resolution:
 *   1. config.projectId
 *   2. parsed from DSN path
 *   3. INARIWATCH_PROJECT_ID env var
 *
 * Without a token AND a projectId the upload is a no-op (returns ok: false).
 * The integration logs a warning to console when debug is enabled.
 */
import type { CaptureConfig } from "../types.js";
import type { CaptureBundle } from "./capture-context.js";
export interface UploadInput {
    config: CaptureConfig;
    screenshot: string;
    description: string;
    bundle: CaptureBundle;
    /** Email collected by the widget. We send it as part of description for now. */
    email?: string;
}
export interface UploadResult {
    ok: boolean;
    reportId?: string;
    alertId?: string;
    error?: string;
    status?: number;
}
export declare function uploadVisualReport(input: UploadInput): Promise<UploadResult>;
//# sourceMappingURL=upload.d.ts.map