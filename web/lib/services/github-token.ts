/**
 * GitHub auth resolver — single source of truth for "give me a usable
 * token + owner for this project's GitHub integration."
 *
 * Two backends, transparent to callers:
 *   1. App installation (preferred when integration row has installation_id)
 *      — mints a fresh installation access token via getInstallationToken,
 *        caches it for ~50 min (the token TTL is 1h, leaving a 10-min margin
 *        for clock skew + in-flight requests).
 *   2. PAT (legacy)
 *      — returns the encrypted token + owner from configEncrypted.
 *
 * Callers should not branch on the auth strategy themselves — that's the
 * whole point. Pass the resolved `token` to lib/services/github-api.ts as
 * before; it works the same for both.
 *
 * Migration 0084: installation_id column added; this module is the
 * read-side counterpart that lets the rest of the codebase stay token-shaped.
 */

import { decryptConfig } from "@/lib/crypto";
import { getInstallationToken } from "@/lib/github-app/octokit";

/**
 * Resolved auth bundle — every call site needs at minimum a bearer token
 * and the owning login. Callers that need the per-repo selection still read
 * `configEncrypted` themselves; this resolver only owns the *credential*.
 */
export type ResolvedGitHubAuth = {
  token: string;
  owner: string;
  /** "app" when minted from an installation, "pat" when read from configEncrypted. */
  source: "app" | "pat";
};

/**
 * Subset of `project_integrations` row needed to resolve auth. Loose-typed
 * to avoid leaking Drizzle column types into call sites that read these
 * three fields out of broader queries.
 */
type IntegrationRow = {
  service?: string;
  configEncrypted: unknown;
  installationId: number | null;
};

// ── In-process installation token cache ──────────────────────────────────────
//
// GitHub installation tokens are valid for 1h. We cap our reuse at 50min so
// we never hand out a token that's about to expire mid-request. The cache is
// keyed by installation_id, so multiple projects sharing one installation
// share one token.

type CacheEntry = { token: string; expiresAt: number };
const tokenCache = new Map<number, CacheEntry>();
const CACHE_TTL_MS = 50 * 60 * 1000;

async function getCachedInstallationToken(installationId: number): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > now) return cached.token;

  const token = await getInstallationToken(installationId);
  tokenCache.set(installationId, { token, expiresAt: now + CACHE_TTL_MS });
  return token;
}

/**
 * Resolve a GitHub auth bundle for a `project_integrations` row.
 *
 * Throws when the row is malformed (no installation_id AND no PAT). The
 * caller is expected to short-circuit on missing integration upstream;
 * this function assumes you already confirmed `service === "github"`.
 */
export async function resolveGitHubAuth(
  integration: IntegrationRow,
): Promise<ResolvedGitHubAuth> {
  const cfg = decryptConfig(integration.configEncrypted);
  const owner = (cfg.owner as string | undefined) ?? "";
  if (!owner) {
    throw new Error("github integration missing owner in configEncrypted");
  }

  if (integration.installationId) {
    const token = await getCachedInstallationToken(integration.installationId);
    return { token, owner, source: "app" };
  }

  const pat = cfg.token as string | undefined;
  if (!pat) {
    throw new Error(
      "github integration has neither installation_id nor PAT — reconnect required",
    );
  }
  return { token: pat, owner, source: "pat" };
}

/**
 * Test-only: drop the installation-token cache. Production code never needs
 * to call this — installation tokens roll over via TTL.
 */
export function __resetGitHubTokenCacheForTests(): void {
  tokenCache.clear();
}
