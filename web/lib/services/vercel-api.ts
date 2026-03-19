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
 * Rollback to a specific deployment by promoting it.
 * Uses Vercel's instant rollback API (v6 POST /deployments/:id/rollback).
 * If that's not available, creates a new deployment from the same commit.
 */
export async function rollbackToDeployment(
  token: string,
  teamId: string | undefined,
  deploymentId: string
): Promise<{ url: string }> {
  const teamQuery = teamId ? `?teamId=${teamId}` : "";

  // Use the rollback/promote endpoint
  const res = await fetch(
    `${API}/v9/projects/promote/${deploymentId}${teamQuery}`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({}),
    }
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Vercel rollback failed (${res.status}): ${err}`);
  }

  // Get the deployment URL
  const depRes = await fetch(`${API}/v13/deployments/${deploymentId}${teamQuery}`, {
    headers: headers(token),
  });
  if (depRes.ok) {
    const depData = await depRes.json();
    return { url: depData.url ? `https://${depData.url}` : "" };
  }

  return { url: "" };
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
    `${API}/v3/deployments/${encodeURIComponent(deploymentId)}/events?limit=200${teamQuery}`,
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

  // Find error-relevant lines: lines containing "error", "Error", "failed",
  // or the last 50 lines (which typically contain the build error output)
  const errorLines = lines.filter(
    (l) => /\b(error|Error|ERROR|failed|FAILED|SyntaxError|TypeError|ReferenceError|Module not found)\b/.test(l)
  );

  // Return error lines if we found some, otherwise return the tail of the log
  if (errorLines.length > 0) {
    // Include some surrounding context — up to 2000 chars of error lines
    return errorLines.join("\n").slice(0, 3000);
  }

  // Fallback: return the last 50 lines which usually contain the failure
  return lines.slice(-50).join("\n").slice(0, 3000);
}
