/**
 * Cloudflare Pages RollbackProvider.
 *
 * Cloudflare Pages API docs:
 *  - GET  /accounts/{account_id}/pages/projects/{project_name}/deployments — list
 *  - POST /accounts/{account_id}/pages/projects/{project_name}/deployments/{id}/rollback
 *  - GET  /accounts/{account_id}/pages/projects/{project_name}/deployments/{id}/history/logs
 *
 * Auth: Cloudflare API token with `Cloudflare Pages:Edit` permission.
 */

import type {
  Deployment,
  ProviderConfig,
  RollbackProvider,
  RollbackResult,
} from "./types";

const API = "https://api.cloudflare.com/client/v4";

interface CloudflareStage {
  name: string; // "queued" | "initialize" | "clone_repo" | "build" | "deploy"
  status: string; // "idle" | "active" | "canceled" | "success" | "failure" | "skipped"
  started_on?: string;
  ended_on?: string;
}

interface CloudflareDeployment {
  id: string;
  url?: string;
  environment: "production" | "preview";
  created_on: string;
  latest_stage?: CloudflareStage;
  deployment_trigger?: { metadata?: { commit_hash?: string; branch?: string } };
  stages?: CloudflareStage[];
}

interface CloudflareResponse<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  messages?: { code: number; message: string }[];
  result: T;
}

export class CloudflarePagesProvider implements RollbackProvider {
  readonly service = "cloudflare-pages" as const;
  private readonly token: string;
  private readonly accountId: string;
  private readonly projectName: string;

  constructor(config: ProviderConfig) {
    if (config.service !== "cloudflare-pages") {
      throw new Error(`CloudflarePagesProvider cannot handle service=${config.service}`);
    }
    if (!config.accountId) {
      throw new Error("CloudflarePagesProvider requires config.accountId");
    }
    this.token = config.token;
    this.accountId = config.accountId;
    this.projectName = config.projectName;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private baseUrl() {
    return `${API}/accounts/${encodeURIComponent(this.accountId)}/pages/projects/${encodeURIComponent(this.projectName)}`;
  }

  private mapState(stage: CloudflareStage | undefined): Deployment["state"] {
    if (!stage) return "unknown";
    if (stage.name === "deploy" && stage.status === "success") return "ready";
    if (stage.status === "failure") return "error";
    if (stage.status === "canceled") return "canceled";
    if (stage.status === "active" || stage.status === "idle") return "building";
    return "unknown";
  }

  private toDeployment(d: CloudflareDeployment): Deployment {
    return {
      id: d.id,
      url: d.url ?? "",
      createdAt: new Date(d.created_on).getTime(),
      state: this.mapState(d.latest_stage),
      commitSha: d.deployment_trigger?.metadata?.commit_hash,
      meta: {
        environment: d.environment,
        branch: d.deployment_trigger?.metadata?.branch,
      },
    };
  }

  async getLastSuccessfulDeploy(): Promise<Deployment | null> {
    const res = await fetch(`${this.baseUrl()}/deployments?env=production`, {
      headers: this.headers(),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as CloudflareResponse<CloudflareDeployment[]>;
    if (!data.success || !Array.isArray(data.result)) return null;

    const ready = data.result.find(
      (d) => d.environment === "production" && this.mapState(d.latest_stage) === "ready",
    );
    return ready ? this.toDeployment(ready) : null;
  }

  async rollbackToDeployment(deploymentId: string): Promise<RollbackResult> {
    const res = await fetch(
      `${this.baseUrl()}/deployments/${encodeURIComponent(deploymentId)}/rollback`,
      { method: "POST", headers: this.headers() },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Cloudflare Pages rollback failed (${res.status}): ${err.slice(0, 200)}`);
    }

    const data = (await res.json()) as CloudflareResponse<CloudflareDeployment>;
    if (!data.success || !data.result) {
      throw new Error(`Cloudflare Pages rollback returned unsuccessful response: ${JSON.stringify(data.errors ?? [])}`);
    }
    return { deploymentId: data.result.id, url: data.result.url ?? "" };
  }

  async getBuildLogs(deploymentId: string): Promise<string | null> {
    const res = await fetch(
      `${this.baseUrl()}/deployments/${encodeURIComponent(deploymentId)}/history/logs`,
      { headers: this.headers() },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as CloudflareResponse<{ data: { line: string }[] }>;
    if (!data.success || !data.result?.data) return null;

    const lines = data.result.data.map((x) => x.line);
    if (lines.length === 0) return null;

    const errorIndex = lines.findIndex((l) =>
      /\b(error -|Error:|SyntaxError:|TypeError:|ReferenceError:|Module not found|failed with exit)\b/i.test(l),
    );
    if (errorIndex !== -1) {
      const start = Math.max(0, errorIndex - 10);
      const end = Math.min(lines.length, errorIndex + 50);
      return lines.slice(start, end).join("\n").slice(0, 4000);
    }
    return lines.slice(-50).join("\n").slice(0, 3000);
  }

  async checkPermissions(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl()}`, { headers: this.headers() });
    return res.ok;
  }
}
