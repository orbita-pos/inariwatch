/**
 * Vercel REST API service for rollback operations.
 */

const API = "https://api.vercel.com";

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Get the last successful production deployment for a project.
 */
export async function getLastSuccessfulDeploy(
  token: string,
  teamId: string | undefined,
  projectName: string
): Promise<{ uid: string; url: string; createdAt: number } | null> {
  const teamQuery = teamId ? `&teamId=${teamId}` : "";
  const res = await fetch(
    `${API}/v6/deployments?projectId=${encodeURIComponent(projectName)}&target=production&state=READY&limit=1${teamQuery}`,
    { headers: headers(token) }
  );
  if (!res.ok) {
    // Try by project name instead of ID
    const res2 = await fetch(
      `${API}/v6/deployments?target=production&state=READY&limit=5${teamQuery}`,
      { headers: headers(token) }
    );
    if (!res2.ok) return null;
    const data2 = await res2.json();
    const match = (data2.deployments ?? []).find(
      (d: { name: string }) => d.name.toLowerCase() === projectName.toLowerCase()
    );
    return match ? { uid: match.uid, url: match.url, createdAt: match.created } : null;
  }
  const data = await res.json();
  const dep = data.deployments?.[0];
  if (!dep) return null;
  return { uid: dep.uid, url: dep.url, createdAt: dep.created };
}

/**
 * Rollback to a specific deployment by creating a new production deployment
 * from it. Uses POST /v13/deployments with deploymentId (documented Vercel API).
 */
export async function rollbackToDeployment(
  token: string,
  teamId: string | undefined,
  deploymentId: string,
  projectName: string
): Promise<{ url: string }> {
  const teamQuery = teamId ? `?teamId=${teamId}` : "";

  const res = await fetch(`${API}/v13/deployments${teamQuery}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      deploymentId,
      name: projectName,
      target: "production",
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Vercel rollback failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  const url = data.url ? `https://${data.url}` : "";
  return { url };
}

/**
 * Check if a Vercel token has deployment permissions.
 */
export async function checkVercelPermissions(
  token: string,
  teamId: string | undefined
): Promise<boolean> {
  const teamQuery = teamId ? `?teamId=${teamId}` : "";
  const res = await fetch(`${API}/v2/user${teamQuery}`, { headers: headers(token) });
  return res.ok;
}

/**
 * Fetch build logs for a failed deployment.
 *
 * Uses Vercel's deployment events API (GET /v3/deployments/{id}/events)
 * to retrieve actual build output including compiler errors.
 *
 * Returns the error-relevant lines (last N lines + any error-level entries),
 * or null if logs can't be fetched.
 */
export async function getDeploymentBuildLogs(
  token: string,
  teamId: string | undefined,
  deploymentId: string
): Promise<string | null> {
  const teamQuery = teamId ? `&teamId=${teamId}` : "";
  const res = await fetch(
    `${API}/v3/deployments/${encodeURIComponent(deploymentId)}/events?limit=1000${teamQuery}`,
    { headers: headers(token) }
  );
  if (!res.ok) return null;

  let events: { type?: string; text?: string; payload?: { text?: string }; created?: number }[];
  try {
    events = await res.json();
  } catch {
    return null;
  }

  if (!Array.isArray(events) || events.length === 0) return null;

  // Extract text from each event — Vercel events have text at top level or inside payload
  const lines: string[] = [];
  for (const ev of events) {
    const text = ev.text ?? ev.payload?.text ?? "";
    if (!text) continue;
    lines.push(text);
  }

  if (lines.length === 0) return null;

  // We reverse the search because we want the *first* error in the build (the actual root cause),
  // not the final "... exited with 1" generic error at the end.
  const errorIndex = lines.findIndex(
    (l) => /\b(error -|Error:|SyntaxError:|TypeError:|ReferenceError:|Module not found)\b/.test(l)
  );

  if (errorIndex !== -1) {
    // Return a window around the error: up to 10 lines before, 50 lines after
    // This captures multi-line Next.js errors that follow the initial "Error" line
    const start = Math.max(0, errorIndex - 10);
    const end = Math.min(lines.length, errorIndex + 50);
    return lines.slice(start, end).join("\n").slice(0, 4000);
  }

  // Fallback: return the last 50 lines which usually contain the failure
  return lines.slice(-50).join("\n").slice(0, 3000);
}

/**
 * Find the latest failed deployment for a project by name.
 * Returns the deployment UID or null if not found.
 */
export async function getLatestFailedDeployment(
  token: string,
  teamId: string | undefined,
  projectName: string
): Promise<string | null> {
  const teamQuery = teamId ? `&teamId=${teamId}` : "";
  const res = await fetch(
    `${API}/v6/deployments?limit=10&state=ERROR${teamQuery}`,
    { headers: headers(token) }
  );
  if (!res.ok) return null;

  const data = await res.json();
  const deployments = (data.deployments ?? []) as { uid: string; name: string; state: string }[];

  // Find the first deployment matching the project name (case-insensitive)
  const match = deployments.find(
    (d) => d.name.toLowerCase() === projectName.toLowerCase()
  );

  return match?.uid ?? deployments[0]?.uid ?? null;
}
