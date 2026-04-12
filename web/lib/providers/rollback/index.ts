/**
 * Rollback provider registry.
 *
 * Central dispatcher — given a ProviderConfig (built from a decrypted
 * `projectIntegrations` row), returns the right RollbackProvider instance.
 *
 * Usage:
 *   const provider = getRollbackProvider({ service: "netlify", token, siteId, projectName })
 *   const lastGood = await provider.getLastSuccessfulDeploy()
 *   if (lastGood) await provider.rollbackToDeployment(lastGood.id)
 */

import type { HostingService, ProviderConfig, RollbackProvider } from "./types";
import { VercelProvider } from "./vercel";
import { NetlifyProvider } from "./netlify";
import { CloudflarePagesProvider } from "./cloudflare-pages";
import { RenderProvider } from "./render";
import { RailwayProvider } from "./railway";
import { FlyProvider } from "./fly";

export { UnsupportedProviderError } from "./types";
export type {
  HostingService,
  Deployment,
  ProviderConfig,
  RollbackProvider,
  RollbackResult,
} from "./types";

/**
 * Full list of services the registry knows about. Used by UI catalogs and
 * webhook routers so a single source-of-truth drives both.
 */
export const SUPPORTED_HOSTING_SERVICES: HostingService[] = [
  "vercel",
  "netlify",
  "cloudflare-pages",
  "render",
  "railway",
  "fly",
];

/**
 * Services where the provider is fully implemented (not a stub). Use this to
 * decide whether `autoRollback` should be offered in the /integrations UI.
 */
export const IMPLEMENTED_HOSTING_SERVICES: HostingService[] = [
  "vercel",
  "netlify",
  "cloudflare-pages",
  "render",
];

export function getRollbackProvider(config: ProviderConfig): RollbackProvider {
  switch (config.service) {
    case "vercel":
      return new VercelProvider(config);
    case "netlify":
      return new NetlifyProvider(config);
    case "cloudflare-pages":
      return new CloudflarePagesProvider(config);
    case "render":
      return new RenderProvider(config);
    case "railway":
      return new RailwayProvider(config);
    case "fly":
      return new FlyProvider(config);
    default: {
      // Exhaustiveness check — TypeScript will error if a new HostingService
      // is added without a case here.
      const _exhaustive: never = config.service;
      throw new Error(`Unknown hosting service: ${String(_exhaustive)}`);
    }
  }
}
