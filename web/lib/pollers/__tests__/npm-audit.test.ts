import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollNpmAudit } from "../npm-audit";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockTextResponse(text: string, ok = true) {
  return {
    ok,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  } as unknown as Response;
}

function mockJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeAdvisory(severity: "critical" | "high" | "medium", pkgName = "lodash") {
  return {
    ghsa_id: `GHSA-xxxx-${severity}`,
    cve_id: `CVE-2023-0001`,
    summary: `${severity} vuln in ${pkgName}`,
    severity,
    vulnerabilities: [{ package: { ecosystem: "npm", name: pkgName }, vulnerable_version_range: "<4.17.21" }],
    html_url: `https://github.com/advisories/GHSA-xxxx-${severity}`,
  };
}

/** OSV batch response format — wraps vulnerabilities per-query */
function makeOSVBatchResponse(vulns: { severity: string; pkgName?: string }[]) {
  return {
    results: vulns.map((v) => ({
      vulns: [{
        id: `GHSA-xxxx-${v.severity}`,
        summary: `${v.severity} vuln in ${v.pkgName ?? "lodash"}`,
        severity: [{ type: "CVSS_V3", score: v.severity === "critical" ? "9.8" : v.severity === "high" ? "7.5" : "4.0" }],
        references: [{ type: "ADVISORY", url: `https://github.com/advisories/GHSA-xxxx-${v.severity}` }],
        affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
      }],
    })),
  };
}

const VALID_PACKAGE_JSON = JSON.stringify({
  name: "my-app",
  dependencies: { lodash: "4.17.20" },
  devDependencies: {},
});

const PKG_URL = "https://raw.githubusercontent.com/acme/repo/main/package.json";
const CARGO_URL = "https://raw.githubusercontent.com/acme/repo/main/Cargo.toml";

const VALID_CARGO_TOML = `
[package]
name = "my-crate"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = "1.0"
`;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pollNpmAudit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns [] when neither packageJsonUrl nor cargoTomlUrl is provided", async () => {
    const alerts = await pollNpmAudit({});
    expect(alerts).toEqual([]);
  });

  it("creates a warning alert when packageJsonUrl fetch returns non-OK", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockTextResponse("", false));

    const alerts = await pollNpmAudit({ packageJsonUrl: PKG_URL });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].title).toBe("[npm] Could not fetch package.json");
  });

  it("creates a warning alert when package.json content is invalid JSON", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockTextResponse("not json"));

    const alerts = await pollNpmAudit({ packageJsonUrl: PKG_URL });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].title).toBe("[npm] Invalid package.json");
  });

  it("creates a critical alert when a critical CVE advisory is returned", async () => {
    // OSV returns 500 → falls back to GitHub Advisory API
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("package.json")) return mockTextResponse(VALID_PACKAGE_JSON);
      if (u.includes("package-lock")) return mockTextResponse("", false);
      if (u.includes("osv.dev")) return mockTextResponse("", false); // OSV fails → fallback
      if (u.includes("api.github.com/advisories")) return mockJsonResponse([makeAdvisory("critical")]);
      return mockTextResponse("", false);
    });

    const alerts = await pollNpmAudit({ packageJsonUrl: PKG_URL });

    const critAlert = alerts.find((a) => a.severity === "critical");
    expect(critAlert).toBeDefined();
    expect(critAlert!.title).toMatch(/\[npm\] \d+ critical CVE\(s\) found/);
    expect(critAlert!.body).toContain("GHSA-xxxx-critical");
  });

  it("creates a warning alert when a high CVE advisory is returned", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("package.json")) return mockTextResponse(VALID_PACKAGE_JSON);
      if (u.includes("package-lock")) return mockTextResponse("", false);
      if (u.includes("osv.dev")) return mockTextResponse("", false);
      if (u.includes("api.github.com/advisories")) return mockJsonResponse([makeAdvisory("high")]);
      return mockTextResponse("", false);
    });

    const alerts = await pollNpmAudit({ packageJsonUrl: PKG_URL });

    const highAlert = alerts.find((a) => a.title.includes("high-severity"));
    expect(highAlert).toBeDefined();
    expect(highAlert!.severity).toBe("warning");
  });

  it("skips critical CVE alert when critical_cves.enabled is false", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(mockTextResponse(VALID_PACKAGE_JSON))
      .mockResolvedValueOnce(mockJsonResponse([makeAdvisory("critical")]));

    const alerts = await pollNpmAudit({ packageJsonUrl: PKG_URL }, { critical_cves: { enabled: false } });

    expect(alerts.some((a) => a.severity === "critical")).toBe(false);
  });

  it("returns no alerts when the advisory API returns no findings", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(mockTextResponse(VALID_PACKAGE_JSON))
      .mockResolvedValueOnce(mockJsonResponse([]));

    const alerts = await pollNpmAudit({ packageJsonUrl: PKG_URL });
    expect(alerts).toEqual([]);
  });

  it("creates a warning alert when cargoTomlUrl fetch fails", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(mockTextResponse("", false));

    const alerts = await pollNpmAudit({ cargoTomlUrl: CARGO_URL });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].title).toBe("[Cargo] Could not fetch Cargo.toml");
  });

  it("creates a critical alert for a Cargo critical CVE", async () => {
    const batchResponse = {
      results: [
        { vulns: [{ id: "GHSA-cargo-crit", summary: "critical vuln in serde", severity: [{ type: "CVSS_V3", score: "9.8" }], references: [{ type: "ADVISORY", url: "https://example.com" }], affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "1.1" }] }] }] }] },
        { vulns: [] }, // tokio — clean
      ],
    };

    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("Cargo.toml")) return mockTextResponse(VALID_CARGO_TOML);
      if (u.includes("Cargo.lock")) return mockTextResponse("", false);
      if (u.includes("osv.dev")) return mockTextResponse("", false); // OSV fails → fallback
      if (u.includes("api.github.com/advisories")) return mockJsonResponse([makeAdvisory("critical", "serde")]);
      return mockTextResponse("", false);
    });

    const alerts = await pollNpmAudit({ cargoTomlUrl: CARGO_URL });

    const critAlert = alerts.find((a) => a.severity === "critical");
    expect(critAlert).toBeDefined();
    expect(critAlert!.title).toMatch(/\[Cargo\] \d+ critical CVE\(s\) found/);
  });
});
