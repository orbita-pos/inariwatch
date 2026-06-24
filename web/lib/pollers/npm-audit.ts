import type { NewAlert } from "@/lib/db";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NpmAuditConfig {
  packageJsonUrl?: string;   // URL to raw package.json (e.g., GitHub raw URL)
  cargoTomlUrl?: string;     // URL to raw Cargo.toml
  packageLockUrl?: string;   // URL to package-lock.json (auto-derived if omitted)
  yarnLockUrl?: string;      // URL to yarn.lock (auto-derived if omitted)
  cargoLockUrl?: string;     // URL to Cargo.lock (auto-derived if omitted)
  token?: string;            // GitHub token for private repos
}

export interface NpmAuditAlertConfig {
  critical_cves?: { enabled: boolean };
  high_cves?:     { enabled: boolean };
}

// ── Shared finding type ─────────────────────────────────────────────────────

interface VulnerabilityFinding {
  name: string;
  severity: string;
  summary: string;
  ghsaId: string;
  url: string;
  vulnerableRange: string;
  patchedVersion: string;
}

// ── GitHub Advisory types ─────────────────────────────────────────────────────

interface GitHubAdvisory {
  ghsa_id: string;
  cve_id: string | null;
  summary: string;
  severity: string; // "critical" | "high" | "medium" | "low"
  vulnerabilities: {
    package: {
      ecosystem: string;
      name: string;
    };
    vulnerable_version_range: string;
    first_patched_version: string | null;
  }[];
  html_url: string;
}

// ── OSV.dev types ────────────────────────────────────────────────────────────

interface OSVVulnerability {
  id: string;
  summary?: string;
  details?: string;
  severity?: { type: string; score: string }[];
  affected?: {
    package?: { name: string; ecosystem: string };
    ranges?: { type: string; events: { introduced?: string; fixed?: string }[] }[];
  }[];
  references?: { type: string; url: string }[];
  database_specific?: { severity?: string };
}

interface OSVBatchResponse {
  results: { vulns?: OSVVulnerability[] }[];
}

// ── In-memory cache (lives within a single serverless invocation) ───────────

const osvCache = new Map<string, { data: VulnerabilityFinding[]; expiresAt: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseGitHubRepoUrl(packageJsonUrl: string): { owner: string; repo: string; branch: string; path: string } | null {
  const rawMatch = packageJsonUrl.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
  );
  if (rawMatch) {
    return { owner: rawMatch[1], repo: rawMatch[2], branch: rawMatch[3], path: rawMatch[4] };
  }

  const apiMatch = packageJsonUrl.match(
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/
  );
  if (apiMatch) {
    return { owner: apiMatch[1], repo: apiMatch[2], branch: "main", path: apiMatch[3] };
  }

  const blobMatch = packageJsonUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
  );
  if (blobMatch) {
    return { owner: blobMatch[1], repo: blobMatch[2], branch: blobMatch[3], path: blobMatch[4] };
  }

  return null;
}

function buildRawUrl(parsed: { owner: string; repo: string; branch: string; path: string }): string {
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.branch}/${parsed.path}`;
}

/** Derive a sibling file URL from a manifest URL (e.g. package.json → package-lock.json) */
function deriveSiblingUrl(manifestUrl: string, siblingFilename: string): string | null {
  const parsed = parseGitHubRepoUrl(manifestUrl);
  if (!parsed) return null;
  const dir = parsed.path.substring(0, parsed.path.lastIndexOf("/") + 1);
  return buildRawUrl({ ...parsed, path: dir + siblingFilename });
}

async function fetchFileContent(url: string, token?: string): Promise<string | null> {
  const parsed = parseGitHubRepoUrl(url);
  const fetchUrl = parsed ? buildRawUrl(parsed) : url;

  const headers: Record<string, string> = {
    "User-Agent": "InariWatch-Monitor/1.0",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(fetchUrl, { headers, next: { revalidate: 0 } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Dependency extraction ───────────────────────────────────────────────────

function extractDependencies(packageJson: Record<string, unknown>): Record<string, string> {
  const deps: Record<string, string> = {};

  const sections = ["dependencies", "devDependencies"] as const;
  for (const section of sections) {
    const sectionDeps = packageJson[section];
    if (sectionDeps && typeof sectionDeps === "object") {
      for (const [name, version] of Object.entries(sectionDeps as Record<string, string>)) {
        deps[name] = version;
      }
    }
  }

  return deps;
}

function extractCargoDependencies(cargoToml: string): string[] {
  const deps: string[] = [];
  let inDeps = false;

  for (const line of cargoToml.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "[dependencies]" || trimmed === "[dev-dependencies]" || trimmed === "[build-dependencies]") {
      inDeps = true;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (trimmed.startsWith("[dependencies.") || trimmed.startsWith("[dev-dependencies.") || trimmed.startsWith("[build-dependencies.")) {
        const name = trimmed.slice(trimmed.indexOf(".") + 1, -1);
        if (name) deps.push(name);
      }
      inDeps = false;
      continue;
    }

    if (inDeps && trimmed.includes("=")) {
      const name = trimmed.split("=")[0].trim();
      if (name && !name.startsWith("#")) {
        deps.push(name);
      }
    }
  }

  return deps;
}

// ── Lockfile parsers ────────────────────────────────────────────────────────

/** Parse package-lock.json (v1, v2, v3) → { name: exactVersion } */
function parsePackageLockJson(content: string): Record<string, string> {
  try {
    const lock = JSON.parse(content);
    const deps: Record<string, string> = {};

    // v2/v3: packages key (node_modules/name → { version })
    if (lock.packages && typeof lock.packages === "object") {
      for (const [key, val] of Object.entries(lock.packages as Record<string, { version?: string }>)) {
        if (!key || key === "") continue; // root entry
        const name = key.replace(/^node_modules\//, "");
        if (val?.version) deps[name] = val.version;
      }
    }
    // v1 fallback: dependencies key
    else if (lock.dependencies && typeof lock.dependencies === "object") {
      for (const [name, val] of Object.entries(lock.dependencies as Record<string, { version?: string }>)) {
        if (val?.version) deps[name] = val.version;
      }
    }

    return deps;
  } catch {
    return {};
  }
}

/** Parse yarn.lock → { name: exactVersion } */
function parseYarnLock(content: string): Record<string, string> {
  try {
    const deps: Record<string, string> = {};
    const blocks = content.split(/\n(?=\S)/);

    for (const block of blocks) {
      const lines = block.split("\n");
      const header = lines[0];
      if (!header || header.startsWith("#")) continue;

      // Extract package name from header like: "lodash@^4.17.20", "lodash@^4.17.20":
      // or "@scope/pkg@^1.0.0":
      const headerClean = header.replace(/["':]/g, "").trim();
      const atIdx = headerClean.lastIndexOf("@");
      if (atIdx <= 0) continue;
      const name = headerClean.substring(0, atIdx);

      // Find version line
      for (const line of lines.slice(1)) {
        const vMatch = line.match(/^\s+version\s+["']?([^"'\s]+)/);
        if (vMatch) {
          deps[name] = vMatch[1];
          break;
        }
      }
    }

    return deps;
  } catch {
    return {};
  }
}

/** Parse Cargo.lock → { name: exactVersion } */
function parseCargoLock(content: string): Record<string, string> {
  try {
    const deps: Record<string, string> = {};
    const blocks = content.split("[[package]]");

    for (const block of blocks) {
      const nameMatch = block.match(/name\s*=\s*"([^"]+)"/);
      const versionMatch = block.match(/version\s*=\s*"([^"]+)"/);
      if (nameMatch && versionMatch) {
        deps[nameMatch[1]] = versionMatch[1];
      }
    }

    return deps;
  } catch {
    return {};
  }
}

// ── Version comparison (for GitHub Advisory fallback) ───────────────────────

/** Compare two semver-like version strings. Returns -1, 0, or 1. */
function compareVersions(a: string, b: string): -1 | 0 | 1 {
  // Strip leading v and pre-release/build metadata for comparison
  const normalize = (v: string) => v.replace(/^v/, "").replace(/[-+].*$/, "");
  const pa = normalize(a).split(".").map(Number);
  const pb = normalize(b).split(".").map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/** Check if a version is affected by a vulnerability range string (e.g. "< 4.17.21" or ">= 2.0.0, < 2.3.1") */
function isVersionAffected(version: string, vulnerableRange: string): boolean {
  if (!vulnerableRange || !version) return true; // assume affected if we can't check

  const conditions = vulnerableRange.split(",").map(c => c.trim());

  for (const cond of conditions) {
    const match = cond.match(/^(>=?|<=?|=)\s*(.+)$/);
    if (!match) continue;

    const [, op, target] = match;
    const cmp = compareVersions(version, target);

    switch (op) {
      case "<":  if (!(cmp < 0)) return false; break;
      case "<=": if (!(cmp <= 0)) return false; break;
      case ">":  if (!(cmp > 0)) return false; break;
      case ">=": if (!(cmp >= 0)) return false; break;
      case "=":  if (!(cmp === 0)) return false; break;
    }
  }

  return true;
}

// ── OSV.dev query ───────────────────────────────────────────────────────────

function mapOSVSeverity(vuln: OSVVulnerability): string {
  // Try CVSS score first
  if (vuln.severity?.length) {
    for (const s of vuln.severity) {
      const score = parseFloat(s.score);
      if (!isNaN(score)) {
        if (score >= 9.0) return "critical";
        if (score >= 7.0) return "high";
        if (score >= 4.0) return "medium";
        return "low";
      }
    }
  }
  // Fallback to database_specific severity
  if (vuln.database_specific?.severity) {
    return String(vuln.database_specific.severity).toLowerCase();
  }
  return "medium";
}

function extractOSVFix(vuln: OSVVulnerability): string {
  if (!vuln.affected?.length) return "";
  for (const a of vuln.affected) {
    if (!a.ranges?.length) continue;
    for (const r of a.ranges) {
      for (const ev of r.events) {
        if (ev.fixed) return ev.fixed;
      }
    }
  }
  return "";
}

/**
 * Query OSV.dev batch API. Returns normalized findings or null on failure (triggers fallback).
 * OSV handles version matching server-side — we send exact versions.
 */
async function queryOSV(
  packages: { name: string; version: string; ecosystem: string }[]
): Promise<VulnerabilityFinding[] | null> {
  if (packages.length === 0) return [];

  const findings: VulnerabilityFinding[] = [];

  // Check cache first, build list of uncached queries
  const uncached: { name: string; version: string; ecosystem: string; index: number }[] = [];
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    const cacheKey = `${pkg.ecosystem}:${pkg.name}:${pkg.version}`;
    const cached = osvCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      findings.push(...cached.data);
    } else {
      uncached.push({ ...pkg, index: i });
    }
  }

  if (uncached.length === 0) return findings;

  // Batch in groups of 100
  for (let i = 0; i < uncached.length; i += 100) {
    const batch = uncached.slice(i, i + 100);
    const queries = batch.map(p => ({
      package: { name: p.name, ecosystem: p.ecosystem },
      version: p.version,
    }));

    try {
      const res = await fetch("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return null; // fallback to GitHub Advisory

      const data: OSVBatchResponse = await res.json();

      for (let j = 0; j < batch.length; j++) {
        const pkg = batch[j];
        const vulns = data.results[j]?.vulns ?? [];
        const cacheKey = `${pkg.ecosystem}:${pkg.name}:${pkg.version}`;
        const pkgFindings: VulnerabilityFinding[] = [];

        for (const vuln of vulns) {
          const severity = mapOSVSeverity(vuln);
          if (severity !== "critical" && severity !== "high") continue;

          const refUrl = vuln.references?.find(r => r.type === "ADVISORY")?.url
            ?? vuln.references?.[0]?.url
            ?? `https://osv.dev/vulnerability/${vuln.id}`;

          pkgFindings.push({
            name: pkg.name,
            severity,
            summary: vuln.summary ?? vuln.details?.slice(0, 200) ?? vuln.id,
            ghsaId: vuln.id,
            url: refUrl,
            vulnerableRange: "",
            patchedVersion: extractOSVFix(vuln),
          });
        }

        osvCache.set(cacheKey, { data: pkgFindings, expiresAt: Date.now() + CACHE_TTL });
        findings.push(...pkgFindings);
      }
    } catch {
      return null; // network error → fallback
    }
  }

  return findings;
}

// ── GitHub Advisory queries (fallback) ──────────────────────────────────────

async function checkNpmAdvisories(
  deps: Record<string, string>,
  token?: string
): Promise<VulnerabilityFinding[]> {
  const depNames = Object.keys(deps);
  if (depNames.length === 0) return [];

  const findings: VulnerabilityFinding[] = [];

  const headers: Record<string, string> = {
    "User-Agent": "InariWatch-Monitor/1.0",
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const batches: string[][] = [];
  for (let i = 0; i < depNames.length; i += 10) {
    batches.push(depNames.slice(i, i + 10));
  }

  for (const batch of batches.slice(0, 5)) {
    for (const pkgName of batch) {
      try {
        const url = `https://api.github.com/advisories?ecosystem=npm&package=${encodeURIComponent(pkgName)}&severity=critical,high&per_page=5`;
        const res = await fetch(url, { headers, next: { revalidate: 0 } });

        if (!res.ok) continue;

        const advisories: GitHubAdvisory[] = await res.json();
        for (const adv of advisories) {
          const vuln = adv.vulnerabilities.find((v) => v.package.name === pkgName);
          findings.push({
            name: pkgName,
            severity: adv.severity,
            summary: adv.summary,
            ghsaId: adv.ghsa_id,
            url: adv.html_url,
            vulnerableRange: vuln?.vulnerable_version_range ?? "",
            patchedVersion: vuln?.first_patched_version ?? "",
          });
        }
      } catch {
        // Skip individual package failures
      }
    }
  }

  // Filter by actual version if lockfile versions available
  return findings.filter(f => {
    const installed = deps[f.name];
    if (!installed || !f.vulnerableRange) return true;
    // If version is a range (^, ~), we can't match exactly — keep finding
    if (/[^0-9.]/.test(installed.charAt(0))) return true;
    return isVersionAffected(installed, f.vulnerableRange);
  });
}

async function checkCargoAdvisories(
  deps: string[],
  token?: string
): Promise<VulnerabilityFinding[]> {
  if (deps.length === 0) return [];

  const findings: VulnerabilityFinding[] = [];

  const headers: Record<string, string> = {
    "User-Agent": "InariWatch-Monitor/1.0",
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  for (const pkgName of deps.slice(0, 30)) {
    try {
      const url = `https://api.github.com/advisories?ecosystem=rust&package=${encodeURIComponent(pkgName)}&severity=critical,high&per_page=5`;
      const res = await fetch(url, { headers, next: { revalidate: 0 } });

      if (!res.ok) continue;

      const advisories: GitHubAdvisory[] = await res.json();
      for (const adv of advisories) {
        const vuln = adv.vulnerabilities.find((v) => v.package.name === pkgName);
        findings.push({
          name: pkgName,
          severity: adv.severity,
          summary: adv.summary,
          ghsaId: adv.ghsa_id,
          url: adv.html_url,
          vulnerableRange: vuln?.vulnerable_version_range ?? "",
          patchedVersion: vuln?.first_patched_version ?? "",
        });
      }
    } catch {
      // Skip individual package failures
    }
  }

  return findings;
}

// ── Poller ───────────────────────────────────────────────────────────────────

export async function pollNpmAudit(
  config: NpmAuditConfig,
  alertConfig: NpmAuditAlertConfig = {}
): Promise<Omit<NewAlert, "projectId">[]> {
  const results: Omit<NewAlert, "projectId">[] = [];

  const checkCritical = alertConfig.critical_cves?.enabled !== false;
  const checkHigh     = alertConfig.high_cves?.enabled     !== false;

  // ── npm dependencies ─────────────────────────────────────────────────────
  if (config.packageJsonUrl) {
    // Fetch manifest + lockfile in parallel
    const lockUrl = config.packageLockUrl
      ?? config.yarnLockUrl
      ?? deriveSiblingUrl(config.packageJsonUrl, "package-lock.json");

    const [manifestContent, lockContent] = await Promise.all([
      fetchFileContent(config.packageJsonUrl, config.token),
      lockUrl ? fetchFileContent(lockUrl, config.token) : Promise.resolve(null),
    ]);

    if (!manifestContent) {
      results.push({
        severity: "warning",
        title: "[npm] Could not fetch package.json",
        body: `Failed to fetch package.json from: ${config.packageJsonUrl}. Check the URL and permissions.`,
        sourceIntegrations: ["npm"],
        isRead: false,
        isResolved: false,
      });
      return results;
    }

    let packageJson: Record<string, unknown>;
    try {
      packageJson = JSON.parse(manifestContent);
    } catch {
      results.push({
        severity: "warning",
        title: "[npm] Invalid package.json",
        body: `Could not parse package.json from: ${config.packageJsonUrl}`,
        sourceIntegrations: ["npm"],
        isRead: false,
        isResolved: false,
      });
      return results;
    }

    const manifestDeps = extractDependencies(packageJson);

    // Parse lockfile for exact versions (transitive deps included)
    let lockDeps: Record<string, string> = {};
    if (lockContent) {
      // Detect lockfile format
      if (config.yarnLockUrl || lockUrl?.includes("yarn.lock")) {
        lockDeps = parseYarnLock(lockContent);
      } else {
        lockDeps = parsePackageLockJson(lockContent);
      }
    }

    // Merge: lockfile versions (exact) override manifest ranges; lockfile also adds transitive deps
    const allDeps: Record<string, string> = { ...manifestDeps, ...lockDeps };

    // Query OSV.dev first (primary), fall back to GitHub Advisory
    const osvPackages = Object.entries(allDeps)
      .filter(([, version]) => version && /^\d/.test(version)) // only exact versions
      .map(([name, version]) => ({ name, version, ecosystem: "npm" }));

    let advisories: VulnerabilityFinding[];

    const osvResult = osvPackages.length > 0 ? await queryOSV(osvPackages) : null;
    if (osvResult !== null) {
      advisories = osvResult;
    } else {
      // Fallback to GitHub Advisory (existing behavior, limited to 50 packages)
      advisories = await checkNpmAdvisories(manifestDeps, config.token);
    }

    const critical = advisories.filter((a) => a.severity === "critical");
    const high     = advisories.filter((a) => a.severity === "high");

    if (checkCritical && critical.length > 0) {
      const details = critical
        .slice(0, 5)
        .map((a) => {
          const range = a.vulnerableRange ? ` (${a.vulnerableRange})` : "";
          const fix = a.patchedVersion ? ` → fix: ${a.patchedVersion}` : " → no patch yet";
          return `• ${a.name}${range}${fix}\n  ${a.summary}\n  ${a.ghsaId}: ${a.url}`;
        })
        .join("\n");

      results.push({
        severity: "critical",
        title: `[npm] ${critical.length} critical CVE(s) found`,
        body: `Critical vulnerabilities in your npm dependencies:\n\n${details}`,
        sourceIntegrations: ["npm"],
        isRead: false,
        isResolved: false,
      });
    }

    if (checkHigh && high.length > 0) {
      const details = high
        .slice(0, 5)
        .map((a) => {
          const range = a.vulnerableRange ? ` (${a.vulnerableRange})` : "";
          const fix = a.patchedVersion ? ` → fix: ${a.patchedVersion}` : " → no patch yet";
          return `• ${a.name}${range}${fix}\n  ${a.summary}\n  ${a.ghsaId}: ${a.url}`;
        })
        .join("\n");

      results.push({
        severity: "warning",
        title: `[npm] ${high.length} high-severity CVE(s) found`,
        body: `High-severity vulnerabilities in your npm dependencies:\n\n${details}`,
        sourceIntegrations: ["npm"],
        isRead: false,
        isResolved: false,
      });
    }
  }

  // ── Cargo dependencies ───────────────────────────────────────────────────
  if (config.cargoTomlUrl) {
    // Fetch manifest + lockfile in parallel
    const cargoLockUrl = config.cargoLockUrl
      ?? deriveSiblingUrl(config.cargoTomlUrl, "Cargo.lock");

    const [manifestContent, lockContent] = await Promise.all([
      fetchFileContent(config.cargoTomlUrl, config.token),
      cargoLockUrl ? fetchFileContent(cargoLockUrl, config.token) : Promise.resolve(null),
    ]);

    if (!manifestContent) {
      results.push({
        severity: "warning",
        title: "[Cargo] Could not fetch Cargo.toml",
        body: `Failed to fetch Cargo.toml from: ${config.cargoTomlUrl}. Check the URL and permissions.`,
        sourceIntegrations: ["npm"],
        isRead: false,
        isResolved: false,
      });
      return results;
    }

    const manifestDeps = extractCargoDependencies(manifestContent);

    // Parse Cargo.lock for exact versions
    let lockDeps: Record<string, string> = {};
    if (lockContent) {
      lockDeps = parseCargoLock(lockContent);
    }

    // Query OSV.dev first with exact versions from lockfile
    const osvPackages = Object.entries(lockDeps)
      .map(([name, version]) => ({ name, version, ecosystem: "crates.io" }));

    let advisories: VulnerabilityFinding[];

    const osvResult = osvPackages.length > 0 ? await queryOSV(osvPackages) : null;
    if (osvResult !== null) {
      advisories = osvResult;
    } else {
      // Fallback to GitHub Advisory
      advisories = await checkCargoAdvisories(manifestDeps, config.token);
    }

    const critical = advisories.filter((a) => a.severity === "critical");
    const high     = advisories.filter((a) => a.severity === "high");

    if (checkCritical && critical.length > 0) {
      const details = critical
        .slice(0, 5)
        .map((a) => {
          const range = a.vulnerableRange ? ` (${a.vulnerableRange})` : "";
          const fix = a.patchedVersion ? ` → fix: ${a.patchedVersion}` : " → no patch yet";
          return `• ${a.name}${range}${fix}\n  ${a.summary}\n  ${a.ghsaId}: ${a.url}`;
        })
        .join("\n");

      results.push({
        severity: "critical",
        title: `[Cargo] ${critical.length} critical CVE(s) found`,
        body: `Critical vulnerabilities in your Cargo dependencies:\n\n${details}`,
        sourceIntegrations: ["npm"],
        isRead: false,
        isResolved: false,
      });
    }

    if (checkHigh && high.length > 0) {
      const details = high
        .slice(0, 5)
        .map((a) => {
          const range = a.vulnerableRange ? ` (${a.vulnerableRange})` : "";
          const fix = a.patchedVersion ? ` → fix: ${a.patchedVersion}` : " → no patch yet";
          return `• ${a.name}${range}${fix}\n  ${a.summary}\n  ${a.ghsaId}: ${a.url}`;
        })
        .join("\n");

      results.push({
        severity: "warning",
        title: `[Cargo] ${high.length} high-severity CVE(s) found`,
        body: `High-severity vulnerabilities in your Cargo dependencies:\n\n${details}`,
        sourceIntegrations: ["npm"],
        isRead: false,
        isResolved: false,
      });
    }
  }

  return results;
}
