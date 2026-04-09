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

// In-memory registry as fast local cache + Redis for cross-instance sharing
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
export async function isServiceAvailable(service: ServiceName): Promise<boolean> {
  // GitHub is critical — always attempt
  if (service === "github") return true;

  // Check local cache first
  const local = getHealth(service);
  if (local.status === "down") {
    const elapsed = Date.now() - (local.downSince?.getTime() ?? 0);
    if (elapsed < COOLDOWN_MS) return false;
    local.status = "degraded";
    registry.set(service, local);
    return true;
  }
  if (local.status === "degraded" && local.lastCheck.getTime() > Date.now() - 30_000) {
    // Local cache is fresh (< 30s) and degraded — still available
    return true;
  }

  // Check Redis for cross-instance state
  try {
    const { getRedis } = await import("@/lib/redis");
    const redis = getRedis();
    if (redis) {
      const data = await redis.hgetall<{ failures: string; status: string; downSince: string; lastError: string }>(`svc:${service}`);
      if (data?.status === "down") {
        const downSince = Number(data.downSince || 0);
        if (Date.now() - downSince < COOLDOWN_MS) {
          // Sync to local cache
          registry.set(service, { status: "down", lastCheck: new Date(), consecutiveFailures: Number(data.failures), lastError: data.lastError ?? "", downSince: new Date(downSince) });
          return false;
        }
      }
    }
  } catch {
    // Redis unavailable — use local only
  }

  return true;
}

/** Record a successful service call */
export function recordSuccess(service: ServiceName): void {
  registry.set(service, {
    status: "healthy",
    lastCheck: new Date(),
    consecutiveFailures: 0,
    lastError: "",
  });
  // Sync to Redis (fire-and-forget)
  import("@/lib/redis").then(({ getRedis }) => {
    const redis = getRedis();
    if (redis) redis.del(`svc:${service}`).catch(() => {});
  }).catch(() => {});
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

  // Sync to Redis (fire-and-forget)
  import("@/lib/redis").then(({ getRedis }) => {
    const redis = getRedis();
    if (redis) {
      redis.hset(`svc:${service}`, {
        failures: String(health.consecutiveFailures),
        status: health.status,
        downSince: String(health.downSince?.getTime() ?? 0),
        lastError: error.slice(0, 200),
      }).catch(() => {});
      redis.expire(`svc:${service}`, 300).catch(() => {}); // 5 min TTL
    }
  }).catch(() => {});
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
  if (!(await isServiceAvailable(service))) return null;

  try {
    const result = await fn();
    recordSuccess(service);
    return result;
  } catch (e) {
    recordFailure(service, e instanceof Error ? e.message : String(e));
    return null;
  }
}
