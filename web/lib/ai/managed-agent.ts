/**
 * Claude Managed Agent shim — v0.3 S2.5.
 *
 * The Anthropic Managed Agents (beta) integration moved into
 * `packages/ai-router/src/providers/anthropic-managed-agent.ts` so the raw
 * api.anthropic.com fetches live inside the router's allowlisted directory.
 * This file is a domain shim that:
 *
 *   1. Re-exports the typed result + params for callers (remediate.ts).
 *   2. Wires the GitHub branch verifier — the router can't import
 *      `web/lib/services/github-api`, so we inject the verifier as a
 *      callback through the router's `verifyBranch` parameter.
 *
 * The feature is gated off in production via `MANAGED_AGENT_ENABLED=false`.
 * remediate.ts imports this module dynamically only when the flag is on.
 */

import {
  runManagedRemediation as routerRun,
  type ManagedAgentParams as RouterParams,
  type ManagedAgentResult as RouterResult,
} from "@inariwatch/ai-router";

export type ManagedAgentResult = RouterResult;

/**
 * Public surface preserved verbatim so remediate.ts doesn't change. The
 * router-side type accepts an optional `verifyBranch` callback; we always
 * supply one that hits GitHub from web's own service layer.
 */
export type ManagedAgentParams = Omit<RouterParams, "verifyBranch"> & {
  /**
   * Optional override for tests. Defaults to a real GitHub call via
   * `getBranchSha`.
   */
  verifyBranch?: RouterParams["verifyBranch"];
};

export async function runManagedRemediation(
  params: ManagedAgentParams,
): Promise<ManagedAgentResult> {
  const verifyBranch =
    params.verifyBranch ?? buildDefaultVerifier(params.repositoryUrl, params.githubToken);
  return routerRun({ ...params, verifyBranch });
}

function buildDefaultVerifier(
  repositoryUrl: string,
  githubToken: string,
): (branch: string) => Promise<boolean> {
  return async (branch) => {
    const [, owner, repo] =
      repositoryUrl.match(/github\.com\/([^/]+)\/([^/.]+)/) ?? [];
    if (!owner || !repo) return false;
    try {
      const { getBranchSha } = await import("@/lib/services/github-api");
      await getBranchSha(githubToken, owner, repo, branch);
      return true;
    } catch {
      return false;
    }
  };
}
