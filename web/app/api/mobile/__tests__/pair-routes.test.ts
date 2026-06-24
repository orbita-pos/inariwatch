/**
 * S12 — /api/mobile/pair routes contract tests.
 *
 * Mocks the service layer so we assert request shape + status codes
 * + bearer-auth gating without booting Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Service mocks ────────────────────────────────────────────────────
//
// `vi.mock` is hoisted by the vitest transform to the top of the
// file, so any closures referenced in the factory must come from
// `vi.hoisted` (which IS allowed to capture top-level state for the
// hoisted block).

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  redeem:   vi.fn(),
  confirm:  vi.fn(),
  status:   vi.fn(),
  rate:     vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/services/mobile-pairing.service", () => {
  class MobilePairingError extends Error {
    constructor(public code: string, msg: string) { super(msg); }
  }
  return {
    MobilePairingError,
    announceChallenge: mocks.announce,
    redeemCode:        mocks.redeem,
    confirmChallenge:  mocks.confirm,
    challengeStatus:   mocks.status,
  };
});

vi.mock("@/lib/services/mobile-relay.service", () => ({
  notifyDesktopSasShown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth-rate-limit", () => ({
  rateLimit: mocks.rate,
}));

vi.mock("@/lib/webhooks/rate-limit", () => ({
  extractClientIp: () => "1.1.1.1",
}));

const { announce, redeem, confirm, status } = mocks;

import { POST as redeemPOST } from "../pair/redeem/route";
import { GET as statusGET }   from "../pair/status/route";
import { POST as announcePOST } from "../pair/_announce/route";
import { POST as confirmPOST } from "../pair/_confirm/route";

const SECRET = "0123456789abcdef".repeat(2);
function makeJsonReq(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method:  "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body:    JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.MOBILE_DEVICE_JWT_SECRET = SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  vi.clearAllMocks();
});

describe("POST /api/mobile/pair/redeem", () => {
  it("returns sas digits on success", async () => {
    redeem.mockResolvedValueOnce({
      challengeId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sasDigits:   "482619",
      displayName: "Pixel 7",
    });
    const r = await redeemPOST(makeJsonReq("https://x/api/mobile/pair/redeem", {
      code:          "ABCDEFGH",
      device_pubkey: "abcdef0123456789abcdef0123456789",
      display_name:  "Pixel 7",
    }) as never);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sas_digits: string };
    expect(body.sas_digits).toBe("482619");
  });

  it("400 on missing fields", async () => {
    const r = await redeemPOST(
      makeJsonReq("https://x/api/mobile/pair/redeem", { code: "ABC" }) as never,
    );
    expect(r.status).toBe(400);
  });

  it("404 when service returns code_unknown", async () => {
    const { MobilePairingError } = await import("@/lib/services/mobile-pairing.service");
    redeem.mockRejectedValueOnce(new MobilePairingError("code_unknown", "x"));
    const r = await redeemPOST(makeJsonReq("https://x/api/mobile/pair/redeem", {
      code:          "ABCDEFGH",
      device_pubkey: "abcdef0123456789abcdef0123456789",
      display_name:  "Pixel 7",
    }) as never);
    expect(r.status).toBe(404);
  });

  it("410 when expired", async () => {
    const { MobilePairingError } = await import("@/lib/services/mobile-pairing.service");
    redeem.mockRejectedValueOnce(new MobilePairingError("code_expired", "x"));
    const r = await redeemPOST(makeJsonReq("https://x/api/mobile/pair/redeem", {
      code:          "ABCDEFGH",
      device_pubkey: "abcdef0123456789abcdef0123456789",
      display_name:  "Pixel 7",
    }) as never);
    expect(r.status).toBe(410);
  });

  it("429 when rate-limited", async () => {
    const { rateLimit } = await import("@/lib/auth-rate-limit");
    (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 30,
    });
    const r = await redeemPOST(makeJsonReq("https://x/api/mobile/pair/redeem", {
      code:          "ABCDEFGH",
      device_pubkey: "abcdef0123456789abcdef0123456789",
      display_name:  "Pixel 7",
    }) as never);
    expect(r.status).toBe(429);
  });
});

describe("GET /api/mobile/pair/status", () => {
  it("400 when challenge_id missing", async () => {
    const r = await statusGET(new Request("https://x/api/mobile/pair/status") as never);
    expect(r.status).toBe(400);
  });

  it("400 when challenge_id malformed", async () => {
    const r = await statusGET(
      new Request("https://x/api/mobile/pair/status?challenge_id=not-a-uuid") as never,
    );
    expect(r.status).toBe(400);
  });

  it("returns paired:false before confirm", async () => {
    status.mockResolvedValueOnce({ paired: false });
    const r = await statusGET(
      new Request("https://x/api/mobile/pair/status?challenge_id=11111111-1111-4111-8111-111111111111") as never,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { paired: boolean };
    expect(body.paired).toBe(false);
  });

  it("returns paired:true + token after confirm", async () => {
    status.mockResolvedValueOnce({
      paired: true,
      deviceToken: "x.y.z",
      device: { deviceId: "d1", workspaceId: "w1", displayName: "Pixel" },
    });
    const r = await statusGET(
      new Request("https://x/api/mobile/pair/status?challenge_id=11111111-1111-4111-8111-111111111111") as never,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { paired: boolean; device_token?: string };
    expect(body.paired).toBe(true);
    expect(body.device_token).toBe("x.y.z");
  });
});

describe("POST /api/mobile/pair/_announce  (cron-secret)", () => {
  it("401 without bearer", async () => {
    const r = await announcePOST(
      makeJsonReq("https://x/api/mobile/pair/_announce", {
        workspace_id: "w1",
        pairing_code: "ABCDEFGH",
        created_at_ms: 1,
      }) as never,
    );
    expect(r.status).toBe(401);
  });

  it("401 with wrong bearer", async () => {
    const r = await announcePOST(
      makeJsonReq(
        "https://x/api/mobile/pair/_announce",
        { workspace_id: "w1", pairing_code: "ABCDEFGH", created_at_ms: 1 },
        { authorization: "Bearer wrong" },
      ) as never,
    );
    expect(r.status).toBe(401);
  });

  it("succeeds with correct bearer", async () => {
    announce.mockResolvedValueOnce({ challengeId: "ch1" });
    const r = await announcePOST(
      makeJsonReq(
        "https://x/api/mobile/pair/_announce",
        { workspace_id: "w1", pairing_code: "ABCDEFGH", created_at_ms: 1 },
        { authorization: "Bearer test-cron-secret" },
      ) as never,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { challenge_id: string };
    expect(body.challenge_id).toBe("ch1");
  });
});

describe("POST /api/mobile/pair/_confirm  (cron-secret)", () => {
  it("401 without bearer", async () => {
    const r = await confirmPOST(
      makeJsonReq("https://x/api/mobile/pair/_confirm", {
        challenge_id: "11111111-1111-4111-8111-111111111111",
        approve: true,
      }) as never,
    );
    expect(r.status).toBe(401);
  });

  it("returns approved+device on resolved approve=true", async () => {
    confirm.mockResolvedValueOnce({
      resolved: true,
      device: { deviceId: "d1", workspaceId: "w1", displayName: "Pixel" },
      deviceToken: "x.y.z",
    });
    const r = await confirmPOST(
      makeJsonReq(
        "https://x/api/mobile/pair/_confirm",
        { challenge_id: "11111111-1111-4111-8111-111111111111", approve: true },
        { authorization: "Bearer test-cron-secret" },
      ) as never,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { approved: boolean; device_token: string };
    expect(body.approved).toBe(true);
    expect(body.device_token).toBe("x.y.z");
  });

  it("returns 409 when challenge pending redeem", async () => {
    confirm.mockResolvedValueOnce({ resolved: false });
    const r = await confirmPOST(
      makeJsonReq(
        "https://x/api/mobile/pair/_confirm",
        { challenge_id: "11111111-1111-4111-8111-111111111111", approve: true },
        { authorization: "Bearer test-cron-secret" },
      ) as never,
    );
    expect(r.status).toBe(409);
  });
});
