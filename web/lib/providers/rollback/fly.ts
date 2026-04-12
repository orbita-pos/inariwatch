/**
 * Fly.io RollbackProvider — STUB.
 *
 * Fly's Machines API (https://api.machines.dev/v1) doesn't have a dedicated
 * "rollback" endpoint. Rollback is done by re-creating machines with a
 * previous image tag: find the last-good image from `releases`, then update
 * each machine via `POST /v1/apps/{app}/machines/{id}` with `image: <old>`.
 *
 * When someone needs Fly support:
 *  1. GET /v1/apps/{app}/releases             — list, find last stable
 *  2. GET /v1/apps/{app}/machines             — list machines
 *  3. For each machine: POST /v1/apps/{app}/machines/{id}
 *     body: { config: { image: <previous_image> }, skip_launch: false }
 *  4. Wait for machine state=started before reporting success.
 *
 * There is no build-log endpoint — Fly stores logs in fly.io dashboard.
 */

import type {
  Deployment,
  ProviderConfig,
  RollbackProvider,
  RollbackResult,
} from "./types";
import { UnsupportedProviderError } from "./types";

export class FlyProvider implements RollbackProvider {
  readonly service = "fly" as const;

  constructor(config: ProviderConfig) {
    if (config.service !== "fly") {
      throw new Error(`FlyProvider cannot handle service=${config.service}`);
    }
  }

  async getLastSuccessfulDeploy(): Promise<Deployment | null> {
    throw new UnsupportedProviderError("fly", "Fly.io rollback provider is not yet implemented. Open an issue at orbita-pos/inariwatch to request it.");
  }

  async rollbackToDeployment(_deploymentId: string): Promise<RollbackResult> {
    throw new UnsupportedProviderError("fly");
  }

  async getBuildLogs(_deploymentId: string): Promise<string | null> {
    return null;
  }

  async checkPermissions(): Promise<boolean> {
    return false;
  }
}
