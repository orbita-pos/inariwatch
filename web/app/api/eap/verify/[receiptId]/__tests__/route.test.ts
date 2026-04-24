/**
 * Tests for GET /api/eap/verify/:receiptId — Fase 11 canonical verify endpoint.
 *
 * Covers the three serving modes:
 *   1. Local-first hit (mirror row present) — no upstream call made
 *   2. Upstream fallback (mirror miss) — proxies EAP /chain/:id
 *   3. Chain mode (?chain=1) — skips mirror entirely, always proxies
 *
 * Plus the standard public-endpoint concerns: hex validation, rate limit,
 * EAP unset 503, upstream 404/502, CORS preflight, immutable cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.spyOn(console, "error").mockImplementation(() => undefined);

// Rate limit stub — allow by default; individual tests override.
const rateLimitMock: ReturnType<typeof vi.fn<(ip: string) => Promise<{ allowed: boolean }>>> =
  vi.fn<(ip: string) => Promise<{ allowed: boolean }>>(async () => ({ allowed: true }));
vi.mock("@/lib/webhooks/rate-limit", () => ({
  checkWebhookRateLimit: (ip: string) => rateLimitMock(ip),
  extractClientIp: () => "127.0.0.1",
}));

// Drizzle mock — single select queue per test.
let selectQueue: unknown[][] = [];
function selectChain() {
  const obj: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) obj[m] = () => obj;
  obj.then = (resolve: (v: unknown) => void) => resolve(selectQueue.shift() ?? []);
  return obj;
}
vi.mock("@/lib/db", () => ({ db: { select: () => selectChain() } }));
vi.mock("@/lib/db/schema", () => ({
  eapReceipts: {
    receiptId: "receipt_id",
    alertId: "alert_id",
    remediationSessionId: "remediation_session_id",
    recordingId: "recording_id",
    merkleRoot: "merkle_root",
    signature: "signature",
    signed: "signed",
    eventCount: "event_count",
    attestor: "attestor",
    verified: "verified",
    verifiedAt: "verified_at",
    createdAt: "created_at",
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
}));

// Mock eap-verify-local to assert whether/when the route fires the
// on-first-hit lazy verify path without invoking real crypto or hitting
// Redis/EAP. Flag state is controlled via isLocalVerifyEnabled.
const verifyAndPersistMock = vi.fn(async () => ({
  verified: true as const,
  keyId: "abcdef0123456789",
  durationMs: 1,
}));
let localVerifyFlag = false;
vi.mock("@/lib/services/eap-verify-local", () => ({
  isLocalVerifyEnabled: () => localVerifyFlag,
  verifyAndPersist: verifyAndPersistMock,
}));

const VALID_ID = "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567";

function mkReq(path = `/api/eap/verify/${VALID_ID}`): import("next/server").NextRequest {
  return new Request(`https://app.inariwatch.com${path}`) as unknown as import("next/server").NextRequest;
}

async function loadRoute() {
  return (await import("../route")) as typeof import("../route");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  selectQueue = [];
  rateLimitMock.mockReset();
  rateLimitMock.mockImplementation(async () => ({ allowed: true }));
  vi.unstubAllGlobals();
  verifyAndPersistMock.mockClear();
  localVerifyFlag = false;
});

// ── Receipt ID validation ────────────────────────────────────────────────

describe("receipt id validation", () => {
  it("rejects IDs shorter than 8 characters", async () => {
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: "short" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/hex/);
  });

  it("rejects IDs longer than 64 characters", async () => {
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: "a".repeat(65) }) });
    expect(res.status).toBe(400);
  });

  it("rejects non-hex characters", async () => {
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: "zzzzzzzz" }) });
    expect(res.status).toBe(400);
  });
});

// ── Rate limiting ────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("returns 429 with Retry-After when rate limit exceeded", async () => {
    rateLimitMock.mockImplementation(async () => ({ allowed: false }));
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

// ── Local-first mirror hit ───────────────────────────────────────────────

describe("local mirror hit", () => {
  it("serves from mirror without calling EAP", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    selectQueue.push([
      {
        receiptId: VALID_ID,
        merkleRoot: VALID_ID,
        signature: "sig-hex-aabbcc",
        signed: true,
        eventCount: 7,
        attestor: "inariwatch",
        createdAt: new Date("2026-04-22T12:00:00Z"),
      },
    ]);

    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.receipt_id).toBe(VALID_ID);
    expect(body.merkle_root).toBe(VALID_ID);
    expect(body.signed).toBe(true);
    expect(body.signature).toBe("sig-hex-aabbcc");
    expect(body.event_count).toBe(7);
    expect(body.attestor).toBe("inariwatch");
    expect(body.source).toBe("local");
    expect(body.created_at).toBe("2026-04-22T12:00:00.000Z");

    // Immutable cache + CORS always set.
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("lowercases the receipt id before the mirror lookup", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
    vi.stubGlobal("fetch", vi.fn());
    selectQueue.push([
      {
        receiptId: VALID_ID,
        merkleRoot: VALID_ID,
        signature: null,
        signed: false,
        eventCount: 3,
        attestor: "inariwatch",
        createdAt: new Date("2026-04-22T12:00:00Z"),
      },
    ]);

    const UPPER_ID = VALID_ID.toUpperCase();
    const { GET } = await loadRoute();
    const res = await GET(mkReq(`/api/eap/verify/${UPPER_ID}`), {
      params: Promise.resolve({ receiptId: UPPER_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipt_id).toBe(VALID_ID); // echoed from mirror row (lowercase)
    expect(body.signature).toBeNull();
    expect(body.signed).toBe(false);
  });
});

// ── Upstream fallback ────────────────────────────────────────────────────

describe("upstream fallback when mirror misses", () => {
  beforeEach(() => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
  });

  it("proxies the EAP chain and annotates source=upstream", async () => {
    selectQueue.push([]); // mirror empty
    const upstreamBody = {
      chain: [
        { meta: { receipt_id: VALID_ID, recording_id: "rec_x" }, event_hashes: [] },
      ],
      verification: { all_signatures_valid: true, depth: 1 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(upstreamBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("upstream");
    expect(body.chain[0].meta.receipt_id).toBe(VALID_ID);
    expect(body.verification.all_signatures_valid).toBe(true);
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
  });

  it("returns 404 when upstream 404s", async () => {
    selectQueue.push([]); // mirror empty
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    expect(res.status).toBe(404);
  });

  it("returns 502 on upstream 5xx without leaking upstream body", async () => {
    selectQueue.push([]); // mirror empty
    vi.stubGlobal("fetch", vi.fn(async () => new Response("kaboom internal", { status: 500 })));
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toContain("kaboom");
  });

  it("returns 502 on network error without leaking message", async () => {
    selectQueue.push([]); // mirror empty
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED 10.0.0.1:9402 — private detail");
      }),
    );
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toContain("10.0.0.1");
    expect(body.error).not.toContain("ECONNREFUSED");
  });
});

// ── EAP_SERVER_URL unset ─────────────────────────────────────────────────

describe("EAP_SERVER_URL unset (local dev / pre-deployment)", () => {
  it("returns 503 with hint when mirror miss AND EAP unset", async () => {
    vi.stubEnv("EAP_SERVER_URL", "");
    selectQueue.push([]); // mirror empty → fallback triggers
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/EAP attestation server/);
    expect(body.hint).toBeDefined();
  });

  it("still serves from mirror when EAP unset (local-first)", async () => {
    vi.stubEnv("EAP_SERVER_URL", "");
    selectQueue.push([
      {
        receiptId: VALID_ID,
        merkleRoot: VALID_ID,
        signature: null,
        signed: false,
        eventCount: 1,
        attestor: "inariwatch",
        createdAt: new Date("2026-04-22T12:00:00Z"),
      },
    ]);
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("local");
  });
});

// ── ?chain=1 mode ────────────────────────────────────────────────────────

describe("chain mode (?chain=1)", () => {
  it("skips the mirror and always proxies the full chain", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ chain: [], verification: { all_signatures_valid: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    // Mirror has a row but the route should ignore it in chain mode.
    selectQueue.push([
      {
        receiptId: VALID_ID,
        merkleRoot: VALID_ID,
        signature: "x",
        signed: true,
        eventCount: 1,
        attestor: "inariwatch",
        createdAt: new Date(),
      },
    ]);

    const { GET } = await loadRoute();
    const req = new Request(
      `https://app.inariwatch.com/api/eap/verify/${VALID_ID}?chain=1`,
    ) as unknown as import("next/server").NextRequest;
    const res = await GET(req, { params: Promise.resolve({ receiptId: VALID_ID }) });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.source).toBe("upstream");
  });
});

// ── CORS preflight ───────────────────────────────────────────────────────

describe("CORS preflight", () => {
  it("OPTIONS returns 204 with the expected headers", async () => {
    const { OPTIONS } = await loadRoute();
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toMatch(/GET/);
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });
});

// ── On-first-hit lazy local verify ───────────────────────────────────────
//
// When the feature flag is on AND the mirror row has a signature but no
// persisted verdict, the route must kick off verifyAndPersist without
// blocking the response. Conversely, it must NOT fire when the flag is
// off, when signature is absent (unsigned receipt), or when a verdict
// has already been persisted.

describe("on-first-hit local verify", () => {
  beforeEach(() => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
  });

  function pushMirror(over: Partial<{
    signature: string | null;
    signed: boolean;
    verified: boolean | null;
  }> = {}): void {
    // Use `in` check instead of ?? so explicit null overrides don't get
    // replaced by the default value — ?? only returns the RHS when LHS
    // is null/undefined, which collapses a deliberate null into "ab"…
    selectQueue.push([
      {
        receiptId: VALID_ID,
        merkleRoot: VALID_ID,
        signature: "signature" in over ? over.signature : "ab".repeat(64),
        signed: "signed" in over ? over.signed : true,
        eventCount: 7,
        attestor: "inariwatch",
        createdAt: new Date("2026-04-22T12:00:00Z"),
        verified: "verified" in over ? over.verified : null,
      },
    ]);
  }

  it("fires verifyAndPersist when flag on + signature + verified=null", async () => {
    localVerifyFlag = true;
    pushMirror();
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), {
      params: Promise.resolve({ receiptId: VALID_ID }),
    });
    expect(res.status).toBe(200);

    // Wait a microtask so the fire-and-forget promise schedules.
    await new Promise<void>((r) => queueMicrotask(r));
    expect(verifyAndPersistMock).toHaveBeenCalledTimes(1);
    expect(verifyAndPersistMock).toHaveBeenCalledWith({
      receiptId: VALID_ID,
      signatureHex: "ab".repeat(64),
    });
  });

  it("does NOT fire when flag is off", async () => {
    localVerifyFlag = false;
    pushMirror();
    const { GET } = await loadRoute();
    await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    await new Promise<void>((r) => queueMicrotask(r));
    expect(verifyAndPersistMock).not.toHaveBeenCalled();
  });

  it("does NOT fire when receipt is unsigned (signature null)", async () => {
    localVerifyFlag = true;
    pushMirror({ signature: null, signed: false });
    const { GET } = await loadRoute();
    await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    await new Promise<void>((r) => queueMicrotask(r));
    expect(verifyAndPersistMock).not.toHaveBeenCalled();
  });

  it("does NOT fire when verified has already been persisted", async () => {
    localVerifyFlag = true;
    pushMirror({ verified: true });
    const { GET } = await loadRoute();
    await GET(mkReq(), { params: Promise.resolve({ receiptId: VALID_ID }) });
    await new Promise<void>((r) => queueMicrotask(r));
    expect(verifyAndPersistMock).not.toHaveBeenCalled();
  });

  it("does NOT fire in ?chain=1 mode (bypasses mirror entirely)", async () => {
    localVerifyFlag = true;
    pushMirror();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            chain: [{ meta: { receipt_id: VALID_ID } }],
            verification: { all_signatures_valid: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { GET } = await loadRoute();
    const req = new Request(
      `https://app.inariwatch.com/api/eap/verify/${VALID_ID}?chain=1`,
    ) as unknown as import("next/server").NextRequest;
    await GET(req, { params: Promise.resolve({ receiptId: VALID_ID }) });
    await new Promise<void>((r) => queueMicrotask(r));
    expect(verifyAndPersistMock).not.toHaveBeenCalled();
  });

  it("surfaces verified field in the local response body", async () => {
    localVerifyFlag = false;
    pushMirror({ verified: true });
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), {
      params: Promise.resolve({ receiptId: VALID_ID }),
    });
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.source).toBe("local");
  });

  it("response body has verified=null when not yet verified", async () => {
    localVerifyFlag = false;
    pushMirror({ verified: null });
    const { GET } = await loadRoute();
    const res = await GET(mkReq(), {
      params: Promise.resolve({ receiptId: VALID_ID }),
    });
    const body = await res.json();
    expect(body.verified).toBeNull();
  });
});
