/**
 * Integration health — passive failure detection.
 *
 * When a real call to a third-party service returns 401 (or the equivalent
 * auth-failure signature in a string-based error, e.g. from a git clone on
 * the Hetzner staging server), we flip `is_active = false` and stamp
 * `last_error_at / last_error_message`. The `/integrations` UI can then show
 * a red banner with a one-click Reconnect CTA — so the next time the user
 * loads the dashboard they see *why* remediation (or Preview Fix) stopped
 * working, instead of discovering it through an opaque error days later.
 *
 * Philosophy: zero cron, zero extra API quota. The user's own real
 * remediation / preview / indexation call IS the probe. A passing call
 * resets the flag via `markIntegrationHealthy` on success.
 */

import { db, projectIntegrations } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Heuristic detector: does this error string look like an auth failure from
 * either the GitHub REST API or a `git clone`/`git push` that GitHub
 * rejected? We match both shapes because the Hetzner Go server surfaces
 * clone errors as raw stderr strings.
 */
export function looksLikeGitHubAuthFailure(input: {
  status?: number;
  body?: string;
  errorString?: string;
}): boolean {
  if (input.status === 401) return true;
  const text = `${input.body ?? ""} ${input.errorString ?? ""}`;
  // REST API: {"message":"Bad credentials",...}
  if (/Bad credentials/i.test(text)) return true;
  // git clone: "fatal: could not read Password for 'https://...@github.com': terminal prompts disabled"
  if (/could not read Password/i.test(text) && /github\.com/i.test(text)) return true;
  // git clone: "fatal: Authentication failed for 'https://github.com/..."
  if (/Authentication failed/i.test(text) && /github\.com/i.test(text)) return true;
  // Fine-grained PAT expired: "Resource not accessible by personal access token"
  if (/Resource not accessible by personal access token/i.test(text)) return true;
  return false;
}

/**
 * Mark the GitHub integration for a project as broken. Idempotent (safe to
 * call every retry). If the project has no github integration, no-op.
 */
export async function markGitHubTokenInvalid(
  projectId: string,
  reason: string,
): Promise<void> {
  await db
    .update(projectIntegrations)
    .set({
      isActive: false,
      lastErrorAt: new Date(),
      lastErrorMessage: reason,
      errorCount: sql`${projectIntegrations.errorCount} + 1`,
    })
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "github"),
      ),
    );
}

/**
 * Clear the error state after a successful call. Called after reconnect and
 * on first healthy use of the token. Keeps `errorCount` as a historical
 * counter — we only reset the "currently broken" flags.
 */
export async function markIntegrationHealthy(
  projectId: string,
  service: string,
): Promise<void> {
  await db
    .update(projectIntegrations)
    .set({
      isActive: true,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastSuccessAt: new Date(),
    })
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, service),
      ),
    );
}
