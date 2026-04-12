/**
 * Render RollbackProvider.
 *
 * Render API docs:
 *  - GET  /v1/services/{serviceId}/deploys       — list deploys
 *  - POST /v1/services/{serviceId}/rollback      — { deployId } body
 *  - GET  /v1/services/{serviceId}/deploys/{id}  — deploy details (no log endpoint)
 *
 * Auth: Render API key in Authorization: Bearer.
 *
 * Note: Render doesn't expose raw build logs via the public REST API — logs
 * live in their dashboard. `getBuildLogs` returns null for that reason.
 */

import type {
  Deployment,
  ProviderConfig,
  RollbackProvider,
  RollbackResult,
} from "./types";

const API = "https://api.render.com";

interface RenderDeploy {
  id: string;
  commit?: { id: string; message?: string };
  status: string; // "live" | "build_failed" | "canceled" | "build_in_progress" | ...
  createdAt: string;
  finishedAt?: string;
}

interface RenderDeployListItem {
  deploy: RenderDeploy;
  cursor?: string;
}

export class RenderProvider implements RollbackProvider {
  readonly service = "render" as const;
  private readonly token: string;
  private readonly serviceId: string;
  private readonly projectName: string;

  constructor(config: ProviderConfig) {
    if (config.service !== "render") {
      throw new Error(`RenderProvider cannot handle service=${config.service}`);
    }
    if (!config.serviceId) {
      throw new Error("RenderProvider requires config.serviceId");
    }
    this.token = config.token;
    this.serviceId = config.serviceId;
    this.projectName = config.projectName;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private mapState(renderStatus: string): Deployment["state"] {
    switch (renderStatus) {
      case "live":
        return "ready";
      case "build_failed":
      case "update_failed":
      case "pre_deploy_failed":
        return "error";
      case "canceled":
      case "deactivated":
        return "canceled";
      case "created":
      case "build_in_progress":
      case "update_in_progress":
      case "pre_deploy_in_progress":
        return "building";
      default:
        return "unknown";
    }
  }

  private toDeployment(d: RenderDeploy): Deployment {
    return {
      id: d.id,
      // Render doesn't return a per-deploy URL in the API — use the service URL.
      url: `https://${this.projectName}.onrender.com`,
      createdAt: new Date(d.createdAt).getTime(),
      state: this.mapState(d.status),
      commitSha: d.commit?.id,
    };
  }

  async getLastSuccessfulDeploy(): Promise<Deployment | null> {
    const res = await fetch(
      `${API}/v1/services/${encodeURIComponent(this.serviceId)}/deploys?limit=20`,
      { headers: this.headers() },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as RenderDeployListItem[];
    if (!Array.isArray(data)) return null;

    const ready = data.find((item) => item.deploy.status === "live");
    return ready ? this.toDeployment(ready.deploy) : null;
  }

  async rollbackToDeployment(deploymentId: string): Promise<RollbackResult> {
    const res = await fetch(
      `${API}/v1/services/${encodeURIComponent(this.serviceId)}/rollback`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ deployId: deploymentId }),
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Render rollback failed (${res.status}): ${err.slice(0, 200)}`);
    }

    const data = (await res.json()) as RenderDeploy;
    return {
      deploymentId: data.id,
      url: `https://${this.projectName}.onrender.com`,
    };
  }

  async getBuildLogs(_deploymentId: string): Promise<string | null> {
    // Render's public REST API does not expose build logs — they're dashboard-only.
    // When they add a logs endpoint we'll implement it here.
    return null;
  }

  async checkPermissions(): Promise<boolean> {
    const res = await fetch(
      `${API}/v1/services/${encodeURIComponent(this.serviceId)}`,
      { headers: this.headers() },
    );
    return res.ok;
  }
}
