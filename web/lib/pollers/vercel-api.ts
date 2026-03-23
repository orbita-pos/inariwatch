import type { NewAlert } from "@/lib/db";

export interface VercelAlertConfig {
  failed_production?: { enabled: boolean };
  failed_preview?:    { enabled: boolean };
  projectFilter?:     string[];
}

interface Deployment {
  uid: string;
  name: string;
  state: string;
  target: string | null;
  url: string;
  errorMessage?: string;
  buildingAt?: number;
  createdAt?: number;
  meta?: {
    githubCommitRef?: string;
    githubCommitSha?: string;
    githubCommitMessage?: string;
    branch?: string;
    commitMessage?: string;
  };
  creator?: { name?: string; username?: string; email?: string };
}

export async function pollVercel(
  token: string,
  teamId: string,
  config: VercelAlertConfig = {},
  lookbackMinutes = 10
): Promise<Omit<NewAlert, "projectId">[]> {
  const results: Omit<NewAlert, "projectId">[] = [];

  const checkProd    = config.failed_production?.enabled !== false;
  const checkPreview = config.failed_preview?.enabled    === true;

  // Look back lookbackMinutes
  const since = Date.now() - lookbackMinutes * 60 * 1000;
  const teamQuery = teamId ? `&teamId=${teamId}` : "";

  const res = await fetch(
    `https://api.vercel.com/v6/deployments?limit=50&since=${since}${teamQuery}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 0 },
    }
  );
  if (!res.ok) return results;

  const { deployments }: { deployments: Deployment[] } = await res.json();

  const projectFilter = config.projectFilter;

  for (const dep of deployments) {
    if (dep.state !== "ERROR" && dep.state !== "CANCELED") continue;
    if (projectFilter && projectFilter.length > 0 && !projectFilter.includes(dep.name)) continue;

    const isProduction = dep.target === "production";
    if (isProduction && !checkProd)    continue;
    if (!isProduction && !checkPreview) continue;

    const branch = dep.meta?.githubCommitRef ?? dep.meta?.branch ?? "";
    const commitSha = (dep.meta?.githubCommitSha ?? "").slice(0, 7);
    const commitMsg = dep.meta?.githubCommitMessage ?? dep.meta?.commitMessage ?? "";
    const creatorName = dep.creator?.name ?? dep.creator?.username ?? dep.creator?.email ?? "";
    const buildingAt = dep.buildingAt ? new Date(dep.buildingAt) : null;
    const durationSec = buildingAt ? Math.round((Date.now() - buildingAt.getTime()) / 1000) : null;
    const durationLine = durationSec && durationSec > 0
      ? `Build time: ${durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`}`
      : "";
    const dashUrl = dep.uid ? `https://vercel.com/deployments/${dep.uid}` : "";

    const bodyParts = [
      dep.errorMessage ?? `Build ${dep.state.toLowerCase()}`,
      branch ? `Branch: ${branch}${commitSha ? ` @ ${commitSha}` : ""}` : "",
      commitMsg ? `Commit: ${commitMsg.slice(0, 80)}` : "",
      creatorName ? `Deployed by: ${creatorName}` : "",
      durationLine,
      dashUrl ? `Logs: ${dashUrl}` : (dep.url ? `URL: https://${dep.url}` : ""),
    ].filter(Boolean).join("\n");

    results.push({
      severity: isProduction ? "critical" : "warning",
      title: `${isProduction ? "Production" : "Preview"} deploy failed — ${dep.name}`,
      body: bodyParts,
      sourceIntegrations: ["vercel"],
      isRead: false,
      isResolved: false,
    });
  }

  return results;
}
