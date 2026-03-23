import type { NewAlert } from "@/lib/db";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NpmAuditConfig {
  packageJsonUrl?: string; // URL to raw package.json (e.g., GitHub raw URL)
  cargoTomlUrl?: string;   // URL to raw Cargo.toml
  token?: string;          // GitHub token for private repos
}

export interface NpmAuditAlertConfig {
  critical_cves?: { enabled: boolean };
  high_cves?:     { enabled: boolean };
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseGitHubRepoUrl(packageJsonUrl: string): { owner: string; repo: string; branch: string; path: string } | null {
  // Handle GitHub raw URLs like:
  // https://raw.githubusercontent.com/owner/repo/main/package.json
  const rawMatch = packageJsonUrl.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
  );
  if (rawMatch) {
    return { owner: rawMatch[1], repo: rawMatch[2], branch: rawMatch[3], path: rawMatch[4] };
  }

  // Handle GitHub API URLs like:
  // https://api.github.com/repos/owner/repo/contents/package.json
  const apiMatch = packageJsonUrl.match(
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/
  );
  if (apiMatch) {
    return { owner: apiMatch[1], repo: apiMatch[2], branch: "main", path: apiMatch[3] };
  }

  // Handle regular GitHub URLs like:
  // https://github.com/owner/repo/blob/main/package.json
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
      // Check for [dependencies.foo] style
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

async function checkNpmAdvisories(
  deps: Record<string, string>,
  token?: string
): Promise<{ name: string; severity: string; summary: string; ghsaId: string; url: string; vulnerableRange: string; patchedVersion: string }[]> {
  const depNames = Object.keys(deps);
  if (depNames.length === 0) return [];

  const findings: { name: string; severity: string; summary: string; ghsaId: string; url: string; vulnerableRange: string; patchedVersion: string }[] = [];

  // Query GitHub Advisory Database for npm advisories
  // We check in batches by searching for the user's specific packages
  const headers: Record<string, string> = {
    "User-Agent": "InariWatch-Monitor/1.0",
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Check top-level deps against GitHub Advisory Database
  // Process in batches of 10 package names to avoid API limits
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

  return findings;
}

async function checkCargoAdvisories(
  deps: string[],
  token?: string
): Promise<{ name: string; severity: string; summary: string; ghsaId: string; url: string; vulnerableRange: string; patchedVersion: string }[]> {
  if (deps.length === 0) return [];

  const findings: { name: string; severity: string; summary: string; ghsaId: string; url: string; vulnerableRange: string; patchedVersion: string }[] = [];

  const headers: Record<string, string> = {
    "User-Agent": "InariWatch-Monitor/1.0",
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Check top Cargo dependencies against GitHub Advisory Database
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
    const content = await fetchFileContent(config.packageJsonUrl, config.token);
    if (!content) {
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
      packageJson = JSON.parse(content);
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

    const deps = extractDependencies(packageJson);
    const advisories = await checkNpmAdvisories(deps, config.token);

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
    const content = await fetchFileContent(config.cargoTomlUrl, config.token);
    if (!content) {
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

    const deps = extractCargoDependencies(content);
    const advisories = await checkCargoAdvisories(deps, config.token);

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
