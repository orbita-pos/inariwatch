/**
 * Railway RollbackProvider — STUB.
 *
 * Railway uses a GraphQL API (https://backboard.railway.app/graphql/v2) rather
 * than REST. Rollback is done via the `deploymentRollback` mutation which
 * accepts a `deploymentId`. Build logs come from `deploymentLogs`.
 *
 * This stub keeps the interface compile-clean so the rest of the rollback
 * infrastructure can be built. When a user asks for Railway support, replace
 * the stub with the real GraphQL calls.
 *
 * Implementation notes for whoever finishes this:
 *  1. Query: `{ deployments(input: { projectId, environmentId, serviceId }) { edges { node { id, status, createdAt, meta { commitHash, branch } } } } }`
 *  2. Mutation: `mutation { deploymentRollback(id: $deploymentId) }`
 *  3. Logs: `query { deploymentLogs(deploymentId: $id, limit: 500) { message, severity, timestamp } }`
 */

import type {
  Deployment,
  ProviderConfig,
  RollbackProvider,
  RollbackResult,
} from "./types";
import { UnsupportedProviderError } from "./types";

export class RailwayProvider implements RollbackProvider {
  readonly service = "railway" as const;

  constructor(config: ProviderConfig) {
    if (config.service !== "railway") {
      throw new Error(`RailwayProvider cannot handle service=${config.service}`);
    }
  }

  async getLastSuccessfulDeploy(): Promise<Deployment | null> {
    throw new UnsupportedProviderError("railway", "Railway rollback provider is not yet implemented. Open an issue at orbita-pos/inariwatch to request it.");
  }

  async rollbackToDeployment(_deploymentId: string): Promise<RollbackResult> {
    throw new UnsupportedProviderError("railway");
  }

  async getBuildLogs(_deploymentId: string): Promise<string | null> {
    return null;
  }

  async checkPermissions(): Promise<boolean> {
    return false;
  }
}
