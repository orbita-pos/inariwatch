/**
 * Netlify RollbackProvider.
 *
 * Netlify API docs:
 *  - GET  /api/v1/sites/{site_id}/deploys         — list deploys
 *  - POST /api/v1/sites/{site_id}/deploys/{id}/restore — promote a deploy to production
 *  - GET  /api/v1/deploys/{id}/log                — build logs
 *
 * Auth: Personal access token in `Authorization: Bearer`.
 */

import type {
  Deployment,
  ProviderConfig,
  RollbackProvider,
  RollbackResult,
} from "./types";

const API = "https://api.netlify.com";

interface NetlifyDeploy {
  id: string;
  state: string; // "ready" | "error" | "building" | "uploading" | ...
  deploy_url?: string;
  deploy_ssl_url?: string;
  ssl_url?: string;
  url?: string;
  created_at: string; // ISO 8601
  commit_ref?: string;
  branch?: string;
  context?: string; // "production" | "deploy-preview" | "branch-deploy"
}

export class NetlifyProvider implements RollbackProvider {
  readonly service = "netlify" as const;
  private readonly token: string;
  private readonly siteId: string;

  constructor(config: ProviderConfig) {
    if (config.service !== "netlify") {
      throw new Error(`NetlifyProvider cannot handle service=${config.service}`);
    }
    if (!config.siteId) {
      throw new Error("NetlifyProvider requires config.siteId");
    }
    this.token = config.token;
    this.siteId = config.siteId;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private mapState(netlifyState: string): Deployment["state"] {
    switch (netlifyState) {
      case "ready": return "ready";
      case "error": return "error";
      case "building":
      case "enqueued":
      case "uploading":
      case "uploaded":
      case "preparing":
      case "prepared":
      case "processing":
        return "building";
      case "new": return "building";
      default: return "unknown";
    }
  }

  private toDeployment(d: NetlifyDeploy): Deployment {
    return {
      id: d.id,
      url: d.ssl_url ?? d.deploy_ssl_url ?? d.deploy_url ?? d.url ?? "",
      createdAt: new Date(d.created_at).getTime(),
      state: this.mapState(d.state),
      commitSha: d.commit_ref,
      meta: { branch: d.branch, context: d.context },
    };
  }

  async getLastSuccessfulDeploy(): Promise<Deployment | null> {
    // Filter to production deploys, sorted newest-first by default.
    const res = await fetch(
      `${API}/api/v1/sites/${encodeURIComponent(this.siteId)}/deploys?per_page=20`,
      { headers: this.headers() },
    );
    if (!res.ok) return null;

    const deploys = (await res.json()) as NetlifyDeploy[];
    const ready = deploys.find(
      (d) => d.state === "ready" && (d.context === "production" || !d.context),
    );
    return ready ? this.toDeployment(ready) : null;
  }

  async rollbackToDeployment(deploymentId: string): Promise<RollbackResult> {
    const res = await fetch(
      `${API}/api/v1/sites/${encodeURIComponent(this.siteId)}/deploys/${encodeURIComponent(deploymentId)}/restore`,
      { method: "POST", headers: this.headers() },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Netlify rollback failed (${res.status}): ${err.slice(0, 200)}`);
    }

    const data = (await res.json()) as NetlifyDeploy;
    return {
      deploymentId: data.id,
      url: data.ssl_url ?? data.deploy_ssl_url ?? data.url ?? "",
    };
  }

  async getBuildLogs(deploymentId: string): Promise<string | null> {
    // Netlify exposes logs as plain-text streaming — fetch and take the tail.
    const res = await fetch(
      `${API}/api/v1/deploys/${encodeURIComponent(deploymentId)}/log`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!res.ok) return null;

    const text = await res.text().catch(() => "");
    if (!text) return null;

    const lines = text.split("\n");
    // Same heuristic as Vercel: find first error line, return a window around it.
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
    // GET /api/v1/sites/{site_id} — returns 200 if the token can read the site.
    const res = await fetch(`${API}/api/v1/sites/${encodeURIComponent(this.siteId)}`, {
      headers: this.headers(),
    });
    return res.ok;
  }
}
