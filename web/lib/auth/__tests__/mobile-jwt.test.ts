/**
 * S12 — JWT helpers. Sign/verify round-trip + tamper resistance.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  signMobileDeviceToken,
  verifyMobileDeviceToken,
  extractBearer,
} from "../mobile-jwt";

const SECRET = "0123456789abcdef".repeat(2); // 32 bytes

describe("mobile-jwt", () => {
  beforeEach(() => {
    process.env.MOBILE_DEVICE_JWT_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.MOBILE_DEVICE_JWT_SECRET;
  });

  it("round-trips a signed token", () => {
    const t = signMobileDeviceToken({
      device_id:        "11111111-1111-4111-8111-111111111111",
      workspace_id:     "22222222-2222-4222-8222-222222222222",
      paired_device_id: "11111111-1111-4111-8111-111111111111",
    });
    const v = verifyMobileDeviceToken(t);
    expect(v.ok).toBe(true);
    expect(v.claims?.device_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(v.claims?.workspace_id).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("rejects a tampered payload (invalid signature)", () => {
    const t = signMobileDeviceToken({
      device_id:        "a",
      workspace_id:     "w",
      paired_device_id: "a",
    });
    const parts = t.split(".");
    const tampered = `${parts[0]}.${parts[1]}X.${parts[2]}`;
    const v = verifyMobileDeviceToken(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason === "signature" || v.reason === "format").toBe(true);
  });

  it("rejects an expired token", () => {
    const t = signMobileDeviceToken(
      {
        device_id:        "a",
        workspace_id:     "w",
        paired_device_id: "a",
      },
      { ttlSeconds: 60, nowSeconds: 1_000_000 },
    );
    const v = verifyMobileDeviceToken(t, { nowSeconds: 1_000_999 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("expired");
  });

  it("rejects malformed input", () => {
    expect(verifyMobileDeviceToken("not.a.token").ok).toBe(false);
    expect(verifyMobileDeviceToken("only.two").ok).toBe(false);
  });

  it("rejects when secret missing", () => {
    delete process.env.MOBILE_DEVICE_JWT_SECRET;
    const v = verifyMobileDeviceToken("a.b.c");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("secret-missing");
  });

  it("extractBearer parses Authorization header", () => {
    const r = new Request("http://x", { headers: { authorization: "Bearer abc" } });
    expect(extractBearer(r)).toBe("abc");
  });

  it("extractBearer returns null for missing header", () => {
    const r = new Request("http://x");
    expect(extractBearer(r)).toBeNull();
  });

  it("extractBearer returns null for non-bearer scheme", () => {
    const r = new Request("http://x", { headers: { authorization: "Basic xyz" } });
    expect(extractBearer(r)).toBeNull();
  });
});
