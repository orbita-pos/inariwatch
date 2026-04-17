/**
 * Env distribution primitive — computes the Node runtime distribution
 * observed in a project (or in a specific set of fleet sessions).
 *
 * Source: alerts.correlationData.env (Capture SDK v2, Week 3 of Q2).
 * Every alert whose SDK emitted env context contributes one sample to
 * the distribution. Older SDKs that don't emit env are silently dropped
 * — the caller handles the "no env data" skip case.
 *
 * Used by:
 *   - VAR Gate 16 (Multi-Environment Coverage) — compares project
 *     distribution against fleet-replay distribution to detect missing
 *     runtime coverage.
 *   - Future gates (e.g., Gate 14 AI Gateway may route env-aware).
 *
 * The v1 scoring key is "node@<major>" (e.g., node@18, node@20). Full
 * env vectors (platform, arch, app_version) are returned alongside so
 * future gate logic can extend without changing callers.
 */

// DB deps are loaded lazily inside the query functions so pure-function
// consumers (tests, UI computation) don't pay the neon() init cost.
// The pure functions (aggregate, analyzeCoverage, parseNodeMajor) live
// below the Query section and have zero DB imports.

// ── Types ────────────────────────────────────────────────────────────────

export interface EnvVector {
  node: string | null;
  nodeMajor: number | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  sessionCount: number;
}

export interface EnvDistributionEntry {
  /** Traffic percent in [0, 100]. Sum across entries = 100 (when total > 0). */
  trafficPercent: number;
  sessionCount: number;
}

export interface EnvDistribution {
  /** Keyed by "node@<major>", e.g. "node@20". Includes "node@unknown" bucket
   *  for alerts whose env has no parseable node version. */
  distribution: Record<string, EnvDistributionEntry>;
  /** Full env vectors observed — returned alongside so future gate logic
   *  can consume platform/arch/app_version without re-querying. */
  vectors: EnvVector[];
  /** Total samples contributing to this distribution. Zero when no env
   *  data was available for the scope — caller should skip the gate. */
  totalSessions: number;
}

export interface ProjectDistributionInput {
  projectId: string;
  windowDays: number;
}

export interface FleetDistributionInput {
  projectId: string;
  /** Fleet replay session IDs (from fleet_verification_runs.session_results). */
  sessionIds: string[];
}

// ── Project-level distribution ───────────────────────────────────────────

/**
 * Env distribution across all alerts for a project in the rolling window.
 * Used as the "baseline" in Gate 16 — what Node majors the project is
 * actually running in production.
 */
export async function computeProjectEnvDistribution(
  input: ProjectDistributionInput,
): Promise<EnvDistribution> {
  const { projectId, windowDays } = input;
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const { db } = await import("@/lib/db");
  const { alerts } = await import("@/lib/db/schema");
  const { and, eq, gte, isNotNull } = await import("drizzle-orm");

  const rows = await db
    .select({ correlationData: alerts.correlationData })
    .from(alerts)
    .where(
      and(
        eq(alerts.projectId, projectId),
        gte(alerts.createdAt, cutoff),
        isNotNull(alerts.correlationData),
      ),
    );

  return aggregate(rows.map((r) => r.correlationData));
}

// ── Fleet-level distribution ─────────────────────────────────────────────

/**
 * Env distribution across a specific set of fleet sessions. Used as the
 * "challenger" in Gate 16 — which Node majors were actually exercised
 * when Gate 12 replayed the fix.
 */
export async function computeFleetEnvDistribution(
  input: FleetDistributionInput,
): Promise<EnvDistribution> {
  const { projectId, sessionIds } = input;
  if (sessionIds.length === 0) {
    return { distribution: {}, vectors: [], totalSessions: 0 };
  }

  const { db } = await import("@/lib/db");
  const { alerts } = await import("@/lib/db/schema");
  const { and, eq, inArray, isNotNull } = await import("drizzle-orm");

  const rows = await db
    .select({ correlationData: alerts.correlationData })
    .from(alerts)
    .where(
      and(
        eq(alerts.projectId, projectId),
        inArray(alerts.sessionId, sessionIds),
        isNotNull(alerts.correlationData),
      ),
    );

  return aggregate(rows.map((r) => r.correlationData));
}

// ── Aggregation + parsing (testable in isolation) ────────────────────────

/**
 * Exported for unit tests. Given a list of raw correlationData values,
 * aggregate env distributions keyed by node major.
 */
export function aggregate(correlationDataList: unknown[]): EnvDistribution {
  const countsByKey = new Map<string, number>();
  const vectorsByKey = new Map<string, EnvVector>();

  for (const cd of correlationDataList) {
    const env = extractEnv(cd);
    if (env === null) continue;

    const key = env.nodeMajor !== null ? `node@${env.nodeMajor}` : "node@unknown";
    countsByKey.set(key, (countsByKey.get(key) ?? 0) + 1);

    const existing = vectorsByKey.get(key);
    if (existing) {
      existing.sessionCount += 1;
    } else {
      vectorsByKey.set(key, { ...env, sessionCount: 1 });
    }
  }

  const totalSessions = [...countsByKey.values()].reduce((s, n) => s + n, 0);
  const distribution: Record<string, EnvDistributionEntry> = {};
  for (const [key, count] of countsByKey.entries()) {
    distribution[key] = {
      sessionCount: count,
      trafficPercent: totalSessions > 0
        ? Math.round((count / totalSessions) * 10_000) / 100
        : 0,
    };
  }

  // Stable sort vectors by traffic desc so UI renders predictably.
  const vectors = [...vectorsByKey.values()].sort(
    (a, b) => b.sessionCount - a.sessionCount,
  );

  return { distribution, vectors, totalSessions };
}

/**
 * Extract and normalize env from a raw correlationData payload. Returns
 * null when correlationData is missing, malformed, or has no usable env.
 */
function extractEnv(correlationData: unknown): EnvVector | null {
  if (!correlationData || typeof correlationData !== "object") return null;
  const env = (correlationData as { env?: unknown }).env;
  if (!env || typeof env !== "object") return null;

  const e = env as Record<string, unknown>;

  // Accept both `node` (SDK-native) and `node_version` (user-supplied metadata).
  const nodeVer =
    typeof e.node === "string"
      ? e.node
      : typeof e.node_version === "string"
        ? e.node_version
        : null;

  return {
    node: nodeVer,
    nodeMajor: parseNodeMajor(nodeVer),
    platform: typeof e.platform === "string" ? e.platform : null,
    arch: typeof e.arch === "string" ? e.arch : null,
    appVersion: typeof e.app_version === "string" ? e.app_version : null,
    sessionCount: 0,
  };
}

/**
 * Parse "v20.11.1" / "20.11.1" / "node-v22" / "22" → 22.
 * Returns null when no integer major can be extracted.
 */
export function parseNodeMajor(version: string | null): number | null {
  if (!version) return null;
  const match = version.match(/(\d+)/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
}

// ── Coverage scoring (pure) ──────────────────────────────────────────────

export interface CoverageAnalysis {
  /** Traffic-weighted coverage % — sum of project traffic for envs present in fleet. */
  coveragePercent: number;
  missingEnvsHigh: string[];
  missingEnvsMedium: string[];
  /** Did the gate actually apply? false when project distribution is single-key
   *  or when fleet distribution is empty — caller translates to skipReason. */
  applicable: boolean;
  skipReason?: "single-env" | "no-project-data" | "no-fleet-data";
}

export interface CoverageThresholds {
  highPercent: number;
  mediumPercent: number;
}

/**
 * Compare project vs fleet env distributions and return coverage verdict.
 * Pure function — fully deterministic, no DB, no clocks.
 */
export function analyzeCoverage(
  projectDist: EnvDistribution,
  fleetDist: EnvDistribution,
  thresholds: CoverageThresholds,
): CoverageAnalysis {
  const projectKeys = Object.keys(projectDist.distribution);

  if (projectDist.totalSessions === 0) {
    return {
      coveragePercent: 0,
      missingEnvsHigh: [],
      missingEnvsMedium: [],
      applicable: false,
      skipReason: "no-project-data",
    };
  }

  // Single-env project — gate is not meaningful (nothing to diversify against).
  if (projectKeys.length <= 1) {
    return {
      coveragePercent: 100,
      missingEnvsHigh: [],
      missingEnvsMedium: [],
      applicable: false,
      skipReason: "single-env",
    };
  }

  if (fleetDist.totalSessions === 0) {
    return {
      coveragePercent: 0,
      missingEnvsHigh: [],
      missingEnvsMedium: [],
      applicable: false,
      skipReason: "no-fleet-data",
    };
  }

  let coveragePercent = 0;
  const missingHigh: { key: string; traffic: number }[] = [];
  const missingMedium: { key: string; traffic: number }[] = [];

  for (const key of projectKeys) {
    const projEntry = projectDist.distribution[key]!;
    const inFleet = fleetDist.distribution[key] != null;
    if (inFleet) {
      coveragePercent += projEntry.trafficPercent;
    } else {
      if (projEntry.trafficPercent >= thresholds.highPercent) {
        missingHigh.push({ key, traffic: projEntry.trafficPercent });
      } else if (projEntry.trafficPercent >= thresholds.mediumPercent) {
        missingMedium.push({ key, traffic: projEntry.trafficPercent });
      }
    }
  }

  // Descending sort by traffic % so "node@20 (35% traffic)" shows first.
  missingHigh.sort((a, b) => b.traffic - a.traffic);
  missingMedium.sort((a, b) => b.traffic - a.traffic);

  return {
    coveragePercent: Math.round(coveragePercent * 100) / 100,
    missingEnvsHigh: missingHigh.map((m) => m.key),
    missingEnvsMedium: missingMedium.map((m) => m.key),
    applicable: true,
  };
}
