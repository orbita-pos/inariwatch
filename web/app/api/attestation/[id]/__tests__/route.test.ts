/**
 * Tests for GET /api/attestation/:id — the public EAP audit proxy.
 *
 * These lock down the contract clients can rely on:
 *   - only 8-64 hex receipt IDs are accepted
 *   - response passes through upstream chain + verification verbatim
 *   - 404 / 502 / 503 / 400 branches each return the right status
 *   - cache-control declares immutability so CDNs can cache indefinitely
 *   - CORS allows third-party audit tools to call cross-origin
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Silence the error log from the 502 branch so the test output is clean.
vi.spyOn(console, "error").mockImplementation(() => undefined);

// The route imports a rate-limit helper that hits Redis in prod — stub it
// to always allow so every test can exercise the real handler path.
vi.mock("@/lib/webhooks/rate-limit", () => ({
  checkWebhookRateLimit: async () => ({ allowed: true }),
  extractClientIp: () => "127.0.0.1",
}));

async function loadRoute() {
  return (await import("../route")) as typeof import("../route");
}

function mkReq(): import("next/server").NextRequest {
  return new Request("https://app.inariwatch.com/api/attestation/abc123def456") as unknown as import("next/server").NextRequest;
}

const VALID_ID = "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567";

beforeEach(() => {
  vi.unstubAllEnvs();
});

// ── Receipt ID validation ────────────────────────────────────────────────

describe("receipt id validation", () => {
  it("rejects IDs shorter than 8 characters", async () => {
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: "short" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/hex/);
  });

  it("rejects IDs longer than 64 characters", async () => {
    const { GET } = await loadRoute();
    const tooLong = "a".repeat(65);
    const res = await GET(mkReq(), { params: Promise.resolve({ id: tooLong }) });
    expect(res.status).toBe(400);
  });

  it("rejects non-hex characters", async () => {
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), {
      params: Promise.resolve({ id: "zzzzzzzzzzzzzzzz" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a canonical 64-hex receipt ID (when EAP unset returns 503)", async () => {
    vi.stubEnv("EAP_SERVER_URL", "");
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(503);
  });

  it("accepts 8-char minimum receipt IDs", async () => {
    vi.stubEnv("EAP_SERVER_URL", "");
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: "abcdef01" }) });
    expect(res.status).toBe(503);
  });
});

// ── EAP_SERVER_URL not configured ────────────────────────────────────────

describe("EAP_SERVER_URL unset (local dev / pre-deployment)", () => {
  it("returns 503 with a hint so UI can render an informational panel", async () => {
    vi.stubEnv("EAP_SERVER_URL", "");
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/EAP attestation server/);
    expect(body.hint).toBeDefined();
  });
});

// ── Proxy behavior ───────────────────────────────────────────────────────

describe("proxy to upstream EAP server", () => {
  beforeEach(() => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
  });

  it("passes through a 200 chain response with immutable cache headers", async () => {
    const chain = {
      chain: [
        {
          meta: {
            receipt_id: VALID_ID,
            recording_id: "rec_xxx",
            command: ["node", "fix.js"],
            runtime: "node",
            event_count: 4,
            started_at: "2026-04-17T00:00:00Z",
            ended_at: "2026-04-17T00:00:05Z",
            eap_version: "0.1.0",
            attested_at: "2026-04-17T00:00:06Z",
          },
          event_hashes: ["h1", "h2", "h3", "h4"],
          categories: { http_request: 2, db_query: 2 },
          surfaces: {},
        },
      ],
      verification: { all_signatures_valid: true, depth: 1, signed: 1, total: 1, links_missing: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(chain), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.json();
    expect(body.verification.verified).toBe(true);
    expect(body.chain[0].meta.receipt_id).toBe(VALID_ID);
  });

  it("returns 404 when upstream 404s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(404);
  });

  it("returns 502 on upstream 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server exploded", { status: 500 })),
    );
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    // Error messages are opaque — no upstream body passthrough.
    expect(body.error).not.toContain("exploded");
  });

  it("returns 502 on network error without leaking the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED 10.0.0.1:9402 — internal detail");
      }),
    );
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toContain("10.0.0.1");
    expect(body.error).not.toContain("ECONNREFUSED");
  });

  it("rejects upstream responses larger than the 1 MB cap", async () => {
    // Fake a content-length well above the limit — route should short-circuit
    // before consuming the stream.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x", {
            status: 200,
            headers: {
              "content-length": String(10 * 1024 * 1024),
              "content-type": "application/json",
            },
          }),
      ),
    );
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(502);
  });
});

// ── CORS preflight ───────────────────────────────────────────────────────

describe("CORS preflight", () => {
  it("OPTIONS returns 204 with the correct Access-Control headers", async () => {
    const { OPTIONS } = await loadRoute();
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toMatch(/GET/);
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });
});
