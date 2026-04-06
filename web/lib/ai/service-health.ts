/**
 * Service health registry for graceful degradation.
 *
 * Tracks consecutive failures for external services (Sentry, Vercel, etc.)
 * and short-circuits calls to services that are down.
 */

export type ServiceStatus = "healthy" | "degraded" | "down";

export interface ServiceHealth {
  status: ServiceStatus;
  lastCheck: Date;
  consecutiveFailures: number;
  lastError: string;
  downSince?: Date;
}

export type ServiceName =
  | "sentry" | "vercel" | "github" | "datadog"
  | "staging" | "eap" | "substrate" | "code_intelligence";

const DOWN_THRESHOLD = 3; // consecutive failures to mark "down"
const COOLDOWN_MS = 2 * 60 * 1000; // 2 min before retrying a "down" service

// In-memory registry — resets on cold start.
// NOTE: In a serverless environment (Vercel), each function instance has its own registry.
// Health state is NOT shared across instances. This is acceptable because the registry is
// a performance optimization (fast-fail on known-down services), not a safety-critical gate.
// For cross-instance health tracking, consider backing with Vercel KV or a DB table.
const registry = new Map<ServiceName, ServiceHealth>();

function getHealth(service: ServiceName): ServiceHealth {
  return registry.get(service) ?? {
    status: "healthy",
    lastCheck: new Date(0),
    consecutiveFailures: 0,
    lastError: "",
  };
}

/** Check if a service call should be attempted */
export function isServiceAvailable(service: ServiceName): boolean {
  // GitHub is critical — always attempt
  if (service === "github") return true;

  const health = getHealth(service);
  if (health.status !== "down") return true;

  // Check cooldown
  const elapsed = Date.now() - (health.downSince?.getTime() ?? 0);
  if (elapsed >= COOLDOWN_MS) {
    // Cooldown elapsed — allow one probe attempt
    health.status = "degraded";
    registry.set(service, health);
    return true;
  }

  return false; // Still down, skip
}

/** Record a successful service call */
export function recordSuccess(service: ServiceName): void {
  registry.set(service, {
    status: "healthy",
    lastCheck: new Date(),
    consecutiveFailures: 0,
    lastError: "",
  });
}

/** Record a failed service call */
export function recordFailure(service: ServiceName, error: string): void {
  const health = getHealth(service);
  health.consecutiveFailures += 1;
  health.lastCheck = new Date();
  health.lastError = error;

  if (health.consecutiveFailures >= DOWN_THRESHOLD) {
    health.status = "down";
    if (!health.downSince) health.downSince = new Date();
  } else {
    health.status = "degraded";
  }

  registry.set(service, health);
}

/** Get status summary for all services (for PR body) */
export function getServiceStatusSummary(): string {
  const services: ServiceName[] = [
    "sentry", "vercel", "github", "datadog", "staging", "eap", "substrate",
  ];

  return services
    .map((s) => {
      const h = getHealth(s);
      const icon = h.status === "healthy" ? "✓" : h.status === "degraded" ? "⚠" : "✗";
      const note = h.status === "down" ? ` (down: ${h.lastError.slice(0, 50)})` : "";
      return `${s}: ${icon}${note}`;
    })
    .join(", ");
}

/**
 * Wrap an async service call with health tracking.
 * If the service is down, returns null immediately without calling fn.
 */
export async function withServiceHealth<T>(
  service: ServiceName,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!isServiceAvailable(service)) return null;

  try {
    const result = await fn();
    recordSuccess(service);
    return result;
  } catch (e) {
    recordFailure(service, e instanceof Error ? e.message : String(e));
    return null;
  }
}
