/**
 * Fase 2b — Container pool client for the worker.
 *
 * Thin HTTP wrappers around /pool/checkout and /pool/return on the
 * inari-staging Go server (see PR #1 in orbita-pos/inari-staging).
 *
 * Feature flag CONTAINER_POOL_ENABLED=false (default) makes every call
 * a no-op: checkoutPoolContainer() returns { source: "cold" } without
 * touching the network, returnPoolContainer() is skipped. The worker's
 * createContainer / destroyContainer cold path continues unchanged.
 *
 * Timeouts are deliberately tight (3s) so a slow or unreachable pool
 * server never adds latency to the cold spawn path. Pool miss (404)
 * and any network error both degrade to cold spawn — the worker never
 * blocks on the pool.
 */

export type ContainerSource = "pool" | "cold";

export interface PoolCheckoutResult {
  containerId: string;
  workspace: string;
  source: ContainerSource;
}

export interface PoolCheckoutParams {
  projectId: string | null | undefined;
  goServer: string;
  secret: string;
}

/**
 * Returns true iff CONTAINER_POOL_ENABLED is the literal string "true".
 * Any other value (including undefined, "false", "1", "yes") disables
 * the pool — strict by design so no one accidentally flips it on with
 * a truthy-but-non-canonical value.
 */
export function isPoolEnabled(): boolean {
  return process.env.CONTAINER_POOL_ENABLED === "true";
}

/**
 * Attempt to claim a warm container from the pool. Returns null (not
 * throw) when the pool is disabled, the projectId is unknown, the pool
 * is empty, or the network call fails — callers treat null as "cold
 * spawn".
 *
 * Never throws. Swallowing errors is a deliberate trade-off: the pool
 * is a latency optimization, not a correctness requirement. A broken
 * pool must not break remediation.
 */
export async function tryPoolCheckout(
  params: PoolCheckoutParams,
): Promise<PoolCheckoutResult | null> {
  if (!isPoolEnabled()) return null;
  if (!params.projectId) return null;

  try {
    const res = await fetch(`${params.goServer}/pool/checkout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project_id: params.projectId }),
      signal: AbortSignal.timeout(3_000),
    });

    if (res.status === 404) {
      // Empty pool — fall back to cold. Not an error.
      return null;
    }

    if (!res.ok) {
      console.warn(`[pool] checkout returned ${res.status}, falling back to cold spawn`);
      return null;
    }

    const data = (await res.json()) as {
      container_id?: string;
      workspace?: string;
      source?: string;
    };
    if (!data.container_id || !data.workspace) {
      console.warn(`[pool] checkout response missing fields, falling back to cold spawn`);
      return null;
    }

    return {
      containerId: data.container_id,
      workspace: data.workspace,
      source: "pool",
    };
  } catch (err) {
    console.warn(`[pool] checkout failed, falling back to cold spawn:`, err);
    return null;
  }
}

export interface PoolReturnParams {
  containerId: string;
  healthy: boolean;
  goServer: string;
  secret: string;
}

/**
 * Hand a pool-origin container back to the Go server for destruction.
 * Cold-spawned containers must NOT call this — they use the existing
 * DELETE /container/{id} path. Callers route based on the `source`
 * field returned from tryPoolCheckout.
 *
 * Never throws. If the return fails, the Go server's TTL cleanup
 * eventually destroys the container (~5 min default).
 */
export async function returnPoolContainer(params: PoolReturnParams): Promise<void> {
  try {
    await fetch(`${params.goServer}/pool/return`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        container_id: params.containerId,
        health_status: params.healthy ? "healthy" : "unhealthy",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(`[pool] return failed (TTL cleanup will handle it):`, err);
  }
}

/**
 * The canonical sandbox_mode column value for a given checkout outcome.
 * Written to remediation_sessions.sandbox_mode so Fase 1's
 * /admin/remediation-lab can show pool hit rate.
 *
 * Returns null when the pool is disabled so the dashboard distinguishes
 * "pool off" from "pool miss".
 */
export function sandboxModeFor(source: ContainerSource | null): string | null {
  if (!isPoolEnabled()) return null;
  if (source === "pool") return "pool-warm";
  return "pool-cold-fallback";
}
