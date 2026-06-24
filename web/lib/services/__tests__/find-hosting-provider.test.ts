/**
 * Tests for findHostingProvider — the auto-heal helper that picks which
 * hosting integration to roll back when uptime detects a down site.
 *
 * Mocks the `db` and `decryptConfig` imports so the test runs without a
 * real DB connection. Validates:
 *  - Priority order (vercel > netlify > cloudflare-pages > render)
 *  - ProviderConfig shape per service
 *  - Inactive/malformed rows are skipped
 *  - Returns null when no hosting integration exists
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks (must be set up before importing the module under test) ──────────

const mockSelect = vi.fn();
const mockDecryptConfig = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { select: mockSelect },
  alerts: { id: "alerts.id" },
  projectIntegrations: {
    projectId: "projectIntegrations.projectId",
    isActive: "projectIntegrations.isActive",
    service: "projectIntegrations.service",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ __and: args }),
  eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ __inArray: [a, b] }),
  sql: (strings: unknown, ..._values: unknown[]) => strings,
}));

vi.mock("@/lib/crypto", () => ({
  decryptConfig: mockDecryptConfig,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/providers/rollback", () => ({
  getRollbackProvider: vi.fn(),
  UnsupportedProviderError: class extends Error {},
}));

function makeRows(rows: Array<{ service: string; config: Record<string, unknown> }>) {
  return rows.map((r, i) => ({
    id: `row-${i}`,
    service: r.service,
    projectId: "proj-1",
    isActive: true,
    configEncrypted: Buffer.from("enc"),
    // Other cols that aren't used by findHostingProvider
  }));
}

// Helper to fake a drizzle `select().from().where()` chain returning `rows`.
function fakeChain(rows: unknown[]) {
  return {
    from: () => ({
      where: async () => rows,
    }),
  };
}

const { findHostingProvider } = await import("../auto-rollback");

// ── Helpers ────────────────────────────────────────────────────────────────

function configFor(service: string): Record<string, unknown> {
  switch (service) {
    case "vercel":
      return { token: "vc_abc", teamId: "team-1", projectId: "prj-vc", projectName: "my-vc" };
    case "netlify":
      return { token: "nfp_abc", siteId: "site-nf", projectName: "my-nf" };
    case "cloudflare-pages":
      return { token: "cf_abc", accountId: "acc-cf", projectName: "my-cf" };
    case "render":
      return { token: "rnd_abc", serviceId: "srv-abc", projectName: "my-rd" };
    default:
      return { token: "x" };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptConfig.mockImplementation((_enc: unknown) => {
    // Default: return based on last service we saw — will be overridden per test.
    return {};
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("findHostingProvider — priority order", () => {
  it("prefers Vercel when multiple hosts are connected", async () => {
    const rows = makeRows([
      { service: "render", config: {} },
      { service: "vercel", config: {} },
      { service: "netlify", config: {} },
    ]);
    mockSelect.mockReturnValue(fakeChain(rows));
    mockDecryptConfig.mockImplementation((enc) => {
      // Use position in rows to return matching config
      const row = rows.find((r) => r.configEncrypted === enc);
      return configFor(row?.service ?? "vercel");
    });

    const result = await findHostingProvider("proj-1");
    expect(result?.service).toBe("vercel");
    expect(result?.token).toBe("vc_abc");
    expect((result as { teamId?: string }).teamId).toBe("team-1");
  });

  it("falls back to Netlify when Vercel absent", async () => {
    const rows = makeRows([
      { service: "render", config: {} },
      { service: "netlify", config: {} },
    ]);
    mockSelect.mockReturnValue(fakeChain(rows));
    mockDecryptConfig.mockImplementation((enc) => {
      const row = rows.find((r) => r.configEncrypted === enc);
      return configFor(row?.service ?? "netlify");
    });

    const result = await findHostingProvider("proj-1");
    expect(result?.service).toBe("netlify");
    expect((result as { siteId?: string }).siteId).toBe("site-nf");
  });

  it("falls back to Cloudflare Pages when Vercel + Netlify absent", async () => {
    const rows = makeRows([
      { service: "cloudflare-pages", config: {} },
      { service: "render", config: {} },
    ]);
    mockSelect.mockReturnValue(fakeChain(rows));
    mockDecryptConfig.mockImplementation((enc) => {
      const row = rows.find((r) => r.configEncrypted === enc);
      return configFor(row?.service ?? "cloudflare-pages");
    });

    const result = await findHostingProvider("proj-1");
    expect(result?.service).toBe("cloudflare-pages");
    expect((result as { accountId?: string }).accountId).toBe("acc-cf");
  });

  it("falls back to Render as last resort", async () => {
    const rows = makeRows([{ service: "render", config: {} }]);
    mockSelect.mockReturnValue(fakeChain(rows));
    mockDecryptConfig.mockImplementation(() => configFor("render"));

    const result = await findHostingProvider("proj-1");
    expect(result?.service).toBe("render");
    expect((result as { serviceId?: string }).serviceId).toBe("srv-abc");
  });
});

describe("findHostingProvider — missing integrations", () => {
  it("returns null when no rows match", async () => {
    mockSelect.mockReturnValue(fakeChain([]));
    const result = await findHostingProvider("proj-1");
    expect(result).toBeNull();
  });

  it("skips rows with missing required fields", async () => {
    const rows = makeRows([
      // Netlify without siteId — should be skipped
      { service: "netlify", config: {} },
      // Render with full config — should be picked
      { service: "render", config: {} },
    ]);
    mockSelect.mockReturnValue(fakeChain(rows));
    mockDecryptConfig
      .mockReturnValueOnce({ token: "nfp_abc" }) // netlify missing siteId
      .mockReturnValueOnce(configFor("render"));

    const result = await findHostingProvider("proj-1");
    expect(result?.service).toBe("render");
  });

  it("skips rows with missing token", async () => {
    const rows = makeRows([{ service: "vercel", config: {} }]);
    mockSelect.mockReturnValue(fakeChain(rows));
    mockDecryptConfig.mockReturnValue({}); // no token

    const result = await findHostingProvider("proj-1");
    expect(result).toBeNull();
  });
});

describe("findHostingProvider — shape validation", () => {
  it("builds Vercel config with correct fallback for projectName", async () => {
    const rows = makeRows([{ service: "vercel", config: {} }]);
    mockSelect.mockReturnValue(fakeChain(rows));
    mockDecryptConfig.mockReturnValue({
      token: "vc_abc",
      teamId: "team-1",
      // No projectId — should fall back to projectName
      projectName: "my-app",
    });

    const result = await findHostingProvider("proj-1");
    expect(result).toMatchObject({
      service: "vercel",
      token: "vc_abc",
      teamId: "team-1",
      projectName: "my-app",
    });
  });

  it("builds Cloudflare Pages config with all required fields", async () => {
    const rows = makeRows([{ service: "cloudflare-pages", config: {} }]);
    mockSelect.mockReturnValue(fakeChain(rows));
    mockDecryptConfig.mockReturnValue(configFor("cloudflare-pages"));

    const result = await findHostingProvider("proj-1");
    expect(result).toMatchObject({
      service: "cloudflare-pages",
      token: "cf_abc",
      accountId: "acc-cf",
      projectName: "my-cf",
    });
  });
});
