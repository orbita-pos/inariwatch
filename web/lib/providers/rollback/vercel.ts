/**
 * Vercel RollbackProvider — thin wrapper around the existing vercel-api.ts
 * HTTP layer. Keeps the low-level fetch calls in one place and adapts their
 * shapes to the provider interface.
 */

import * as vercelApi from "@/lib/services/vercel-api";
import type {
  Deployment,
  ProviderConfig,
  RollbackProvider,
  RollbackResult,
} from "./types";

export class VercelProvider implements RollbackProvider {
  readonly service = "vercel" as const;
  private readonly token: string;
  private readonly teamId: string | undefined;
  private readonly projectName: string;

  constructor(config: ProviderConfig) {
    if (config.service !== "vercel") {
      throw new Error(`VercelProvider cannot handle service=${config.service}`);
    }
    this.token = config.token;
    this.teamId = config.teamId;
    this.projectName = config.projectName;
  }

  async getLastSuccessfulDeploy(): Promise<Deployment | null> {
    const dep = await vercelApi.getLastSuccessfulDeploy(this.token, this.teamId, this.projectName);
    if (!dep) return null;
    return {
      id: dep.uid,
      url: dep.url.startsWith("http") ? dep.url : `https://${dep.url}`,
      createdAt: dep.createdAt,
      state: "ready",
    };
  }

  async rollbackToDeployment(deploymentId: string): Promise<RollbackResult> {
    const result = await vercelApi.rollbackToDeployment(
      this.token,
      this.teamId,
      deploymentId,
      this.projectName,
    );
    return { url: result.url, deploymentId };
  }

  async getBuildLogs(deploymentId: string): Promise<string | null> {
    return vercelApi.getDeploymentBuildLogs(this.token, this.teamId, deploymentId);
  }

  async checkPermissions(): Promise<boolean> {
    return vercelApi.checkVercelPermissions(this.token, this.teamId);
  }
}
