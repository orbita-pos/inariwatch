/**
 * Vercel service — rollback + build logs.
 * Used by: MCP rollback_vercel, MCP get_build_logs, auto-rollback, context-gatherer.
 */

import { db, projects, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";

type VercelConfig = {
  token: string;
  projectId: string;
  teamId?: string;
};

async function getVercelConfig(projectId: string): Promise<VercelConfig | null> {
  const [integration] = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "vercel")
      )
    )
    .limit(1);

  if (!integration) return null;

  const config = integration.configEncrypted as Record<string, string> | null;
  if (!config?.token || !config?.projectId) return null;

  return {
    token: decrypt(config.token),
    projectId: config.projectId,
    teamId: config.teamId,
  };
}

function teamParam(teamId?: string): string {
  return teamId ? `&teamId=${teamId}` : "";
}

// ── Deployments ──────────────────────────────────────────────────────────────

export type Deployment = {
  uid: string;
  state: string;
  url: string | null;
  created: number;
  meta?: { branch?: string; commitSha?: string };
};

export async function getRecentDeployments(
  projectId: string,
  opts?: { state?: string; target?: string; limit?: number }
): Promise<Deployment[]> {
  const cfg = await getVercelConfig(projectId);
  if (!cfg) throw new Error("No Vercel integration configured.");

  const params = new URLSearchParams({
    projectId: cfg.projectId,
    limit: String(opts?.limit ?? 5),
  });
  if (opts?.state) params.set("state", opts.state);
  if (opts?.target) params.set("target", opts.target);
  if (cfg.teamId) params.set("teamId", cfg.teamId);

  const resp = await fetch(`https://api.vercel.com/v6/deployments?${params}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!resp.ok) throw new Error(`Vercel API error: ${resp.status}`);

  const data = await resp.json();
  return (data.deployments ?? []).map((d: Record<string, unknown>) => ({
    uid: d.uid as string,
    state: d.state as string,
    url: d.url as string | null,
    created: d.created as number,
    meta: d.meta as { branch?: string; commitSha?: string },
  }));
}

// ── Rollback ─────────────────────────────────────────────────────────────────

export async function rollbackToDeployment(
  projectId: string,
  deploymentId?: string
): Promise<{ uid: string; url: string | null; created: string }> {
  const cfg = await getVercelConfig(projectId);
  if (!cfg) throw new Error("No Vercel integration configured.");

  const deployments = await getRecentDeployments(projectId, {
    state: "READY",
    target: "production",
    limit: 5,
  });

  const target = deploymentId
    ? deployments.find((d) => d.uid === deploymentId)
    : deployments[1]; // Skip current, use previous

  if (!target) throw new Error("No previous production deployment found.");

  const promoteUrl = `https://api.vercel.com/v13/deployments/${target.uid}/promote${cfg.teamId ? `?teamId=${cfg.teamId}` : ""}`;
  const promoteResp = await fetch(promoteUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (!promoteResp.ok) {
    const err = await promoteResp.text();
    throw new Error(`Rollback failed: ${promoteResp.status} ${err}`);
  }

  return {
    uid: target.uid,
    url: target.url ? `https://${target.url}` : null,
    created: target.created ? new Date(target.created).toISOString() : "",
  };
}

// ── Build logs ───────────────────────────────────────────────────────────────

export async function getBuildLogs(
  projectId: string,
  deploymentId?: string
): Promise<{ deploymentUid: string; state: string; logs: string }> {
  const cfg = await getVercelConfig(projectId);
  if (!cfg) throw new Error("No Vercel integration configured.");

  const deployments = await getRecentDeployments(projectId, { limit: 5 });

  const dep = deploymentId
    ? deployments.find((d) => d.uid === deploymentId)
    : deployments.find((d) => d.state === "ERROR") ?? deployments[0];

  if (!dep) throw new Error("No deployments found.");

  const logsUrl = `https://api.vercel.com/v2/deployments/${dep.uid}/events${cfg.teamId ? `?teamId=${cfg.teamId}` : ""}`;
  const logsResp = await fetch(logsUrl, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!logsResp.ok) throw new Error(`Could not fetch build logs: ${logsResp.status}`);

  const events = await logsResp.json();
  const logLines = Array.isArray(events)
    ? events
        .filter((e: { type: string }) => e.type === "stdout" || e.type === "stderr")
        .map((e: { payload?: { text?: string }; text?: string }) => e.payload?.text ?? e.text ?? "")
        .join("\n")
    : "No log output available.";

  return {
    deploymentUid: dep.uid,
    state: dep.state,
    logs: logLines.slice(0, 5000),
  };
}
