/**
 * RollbackProvider abstraction — host-agnostic interface for deployment
 * lookup and rollback operations. Each hosting platform (Vercel, Netlify,
 * Cloudflare Pages, Render, Railway, Fly.io) implements this contract.
 *
 * Consumers: auto-rollback.ts, context-gatherer.ts, deploy-monitor.
 */

export type HostingService =
  | "vercel"
  | "netlify"
  | "cloudflare-pages"
  | "render"
  | "railway"
  | "fly";

export interface Deployment {
  /** Provider's unique deployment identifier. */
  id: string;
  /** Live URL of the deployment (https://). */
  url: string;
  /** Creation timestamp in milliseconds since epoch. */
  createdAt: number;
  /** Normalized state — every provider maps its own state to one of these. */
  state: "ready" | "error" | "building" | "canceled" | "unknown";
  /** Short commit SHA if the provider exposes it. */
  commitSha?: string;
  /** Provider-specific extra fields (never rely on this for logic). */
  meta?: Record<string, unknown>;
}

/**
 * Config passed to a provider constructor. Callers build this from the
 * `projectIntegrations` row after decrypting `configEncrypted`.
 *
 * Most fields are optional because each provider needs different subsets:
 *  - Vercel: token, teamId, projectName
 *  - Netlify: token, siteId
 *  - Cloudflare Pages: token, accountId, projectName
 *  - Render: token, serviceId
 *  - Railway: token, projectId, environmentId, serviceId
 *  - Fly: token, appName
 */
export interface ProviderConfig {
  service: HostingService;
  /** API token with deploy-scope permissions. */
  token: string;
  /** Display name for the project — used in alerts and logs. */
  projectName: string;

  // ── Per-provider fields (optional) ─────────────────────────────────────
  teamId?: string;         // Vercel
  siteId?: string;         // Netlify
  accountId?: string;      // Cloudflare
  serviceId?: string;      // Render, Railway
  projectId?: string;      // Cloudflare, Railway
  environmentId?: string;  // Railway
  appName?: string;        // Fly
}

export interface RollbackResult {
  /** URL of the deployment that was promoted. */
  url: string;
  /** ID of the deployment that is now live. */
  deploymentId: string;
}

export interface RollbackProvider {
  /** Service this provider handles — matches the discriminator. */
  readonly service: HostingService;

  /** Find the last successful production deployment to roll back to. */
  getLastSuccessfulDeploy(): Promise<Deployment | null>;

  /**
   * Promote the given deployment to production. Providers either promote
   * an existing build (Vercel, Netlify, Cloudflare, Render) or redeploy
   * from a pinned commit (Railway, Fly).
   */
  rollbackToDeployment(deploymentId: string): Promise<RollbackResult>;

  /**
   * Fetch human-readable build logs for the given deployment. Used by the
   * context-gatherer to seed AI diagnosis with the actual build error.
   * Return null if the provider has no build-log API or the lookup fails.
   */
  getBuildLogs(deploymentId: string): Promise<string | null>;

  /** Check that the token has the required permissions. Used by /integrations UI. */
  checkPermissions(): Promise<boolean>;
}

/**
 * Thrown when a provider is asked to operate on a service it doesn't
 * support yet (e.g., Railway or Fly before their impls are finished).
 * Callers should catch this and surface a "not yet implemented" notice.
 */
export class UnsupportedProviderError extends Error {
  constructor(public readonly service: HostingService, message?: string) {
    super(message ?? `Rollback for ${service} is not yet implemented`);
    this.name = "UnsupportedProviderError";
  }
}
