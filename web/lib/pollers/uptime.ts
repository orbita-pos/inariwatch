import type { NewAlert } from "@/lib/db";

// ── Types ────────────────────────────────────────────────────────────────────

export interface UptimeEndpoint {
  url: string;
  name: string;
  expectedStatus: number;
  timeoutMs: number;
}

export interface UptimeAlertConfig {
  downtime?:       { enabled: boolean };
  slow_response?:  { enabled: boolean; thresholdMs: number };
}

// ── Poller ───────────────────────────────────────────────────────────────────

export async function pollUptime(
  endpoints: UptimeEndpoint[],
  alertConfig: UptimeAlertConfig = {}
): Promise<Omit<NewAlert, "projectId">[]> {
  const results: Omit<NewAlert, "projectId">[] = [];

  const checkDown = alertConfig.downtime?.enabled      !== false;
  const checkSlow = alertConfig.slow_response?.enabled  !== false;
  const slowThreshold = alertConfig.slow_response?.thresholdMs ?? 5000;

  for (const endpoint of endpoints) {
    const timeout = endpoint.timeoutMs || 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const start = Date.now();

    try {
      const res = await fetch(endpoint.url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        next: { revalidate: 0 },
      });

      const elapsed = Date.now() - start;
      clearTimeout(timer);

      // Wrong status code → treat as down
      if (res.status !== endpoint.expectedStatus) {
        if (checkDown) {
          results.push({
            severity: "critical",
            title: `[Down] ${endpoint.name} — ${endpoint.url}`,
            body: `Expected status ${endpoint.expectedStatus}, got ${res.status} (${elapsed}ms)`,
            sourceIntegrations: ["uptime"],
            isRead: false,
            isResolved: false,
          });
        }
        continue;
      }

      // Slow response
      if (checkSlow && elapsed > slowThreshold) {
        results.push({
          severity: "warning",
          title: `[Slow] ${endpoint.name} — ${elapsed}ms (threshold: ${slowThreshold}ms)`,
          body: `${endpoint.url} responded in ${elapsed}ms, exceeding the ${slowThreshold}ms threshold`,
          sourceIntegrations: ["uptime"],
          isRead: false,
          isResolved: false,
        });
      }
    } catch (err) {
      clearTimeout(timer);

      if (checkDown) {
        const reason =
          err instanceof DOMException && err.name === "AbortError"
            ? `Request timed out after ${timeout}ms`
            : err instanceof Error
              ? err.message
              : String(err);

        results.push({
          severity: "critical",
          title: `[Down] ${endpoint.name} — ${endpoint.url}`,
          body: reason,
          sourceIntegrations: ["uptime"],
          isRead: false,
          isResolved: false,
        });
      }
    }
  }

  return results;
}
