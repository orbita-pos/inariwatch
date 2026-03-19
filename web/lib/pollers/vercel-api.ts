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

    results.push({
      severity: isProduction ? "critical" : "warning",
      title: `${isProduction ? "Production" : "Preview"} deploy failed — ${dep.name}`,
      body: dep.errorMessage ?? `Build ${dep.state.toLowerCase()} · ${dep.url}`,
      sourceIntegrations: ["vercel"],
      isRead: false,
      isResolved: false,
    });
  }

  return results;
}
