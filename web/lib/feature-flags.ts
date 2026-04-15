/**
 * Feature flags — env-var driven for now (no DB lookup needed).
 *
 * Pattern:
 *   FLAG_NAME=org_uuid_a,org_uuid_b   → enabled for those orgs only
 *   FLAG_NAME=*                       → enabled for everyone
 *   FLAG_NAME unset / empty           → disabled
 */

function flagAllowsOrg(envValue: string | undefined, organizationId: string | null | undefined): boolean {
  if (!envValue) return false;
  const allow = envValue.split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.includes("*")) return true;
  return organizationId ? allow.includes(organizationId) : false;
}

/**
 * Replay V2 (R2-backed block storage + multi-track timeline + AI chapters).
 * Phase 0 endpoints (`/api/replay/*`) require this to accept ingestion.
 */
export function isReplayV2Enabled(organizationId: string | null | undefined): boolean {
  return flagAllowsOrg(process.env.REPLAY_V2_ORGS, organizationId);
}
