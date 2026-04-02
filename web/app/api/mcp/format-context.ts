/**
 * Format correlationData (git, breadcrumbs, env, user, tags, request)
 * into a human-readable string for AI consumption.
 */

export function formatContext(data: Record<string, unknown>): string {
  const parts: string[] = [];

  // Git
  const git = data.git as { commit?: string; branch?: string; message?: string; timestamp?: string; dirty?: boolean } | undefined;
  if (git?.commit) {
    parts.push(`Git: ${git.commit.slice(0, 8)} on ${git.branch ?? "?"} — "${git.message ?? ""}"${git.dirty ? " (dirty)" : ""}`);
  }

  // Breadcrumbs
  const breadcrumbs = data.breadcrumbs as { timestamp?: string; category?: string; message?: string; level?: string }[] | undefined;
  if (breadcrumbs?.length) {
    const lines = breadcrumbs.slice(-10).map((b) =>
      `  ${b.timestamp?.slice(11, 19) ?? "?"} [${b.category}] ${b.message}`
    ).join("\n");
    parts.push(`Breadcrumbs (last ${Math.min(breadcrumbs.length, 10)}):\n${lines}`);
  }

  // Environment
  const env = data.env as { node?: string; platform?: string; heapUsedMB?: number; heapTotalMB?: number; freeMemoryMB?: number; totalMemoryMB?: number; uptime?: number } | undefined;
  if (env?.node) {
    const heap = env.heapUsedMB && env.heapTotalMB ? ` heap ${env.heapUsedMB}/${env.heapTotalMB}MB` : "";
    const mem = env.freeMemoryMB && env.totalMemoryMB ? ` mem ${env.totalMemoryMB - env.freeMemoryMB}/${env.totalMemoryMB}MB` : "";
    parts.push(`Env: ${env.node} ${env.platform ?? ""}${heap}${mem} uptime ${env.uptime ?? "?"}s`);
  }

  // Request
  const request = data.request as { method?: string; url?: string; headers?: Record<string, string>; body?: unknown } | undefined;
  if (request?.method) {
    let reqStr = `Request: ${request.method} ${request.url}`;
    if (request.body) reqStr += ` body: ${JSON.stringify(request.body).slice(0, 200)}`;
    parts.push(reqStr);
  }

  // User
  const user = data.user as { id?: string; role?: string } | undefined;
  if (user?.id) {
    parts.push(`User: ${user.id}${user.role ? ` (${user.role})` : ""}`);
  }

  // Tags
  const tags = data.tags as Record<string, string> | undefined;
  if (tags && Object.keys(tags).length > 0) {
    parts.push(`Tags: ${Object.entries(tags).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  return parts.length > 0 ? parts.join("\n") + "\n" : "";
}
