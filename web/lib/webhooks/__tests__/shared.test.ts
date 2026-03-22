import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// ── Mock DB ──────────────────────────────────────────────────────────────────

let selectResults: unknown[][] = [];
let selectIndex = 0;
const insertedValues: unknown[] = [];

function chainable(result: unknown[]) {
  return {
    from: () => ({
      innerJoin: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => result,
          }),
        }),
      }),
      where: () => ({
        limit: () => result,
      }),
    }),
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    select: (cols?: unknown) => {
      const idx = selectIndex++;
      return chainable(selectResults[idx] ?? []);
    },
    insert: () => ({
      values: (v: unknown) => {
        insertedValues.push(v);
        return {
          returning: () => [{ id: `alert-${insertedValues.length}`, createdAt: new Date(), ...(v as object) }],
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  },
  alerts: { id: "id", projectId: "projectId", title: "title", isResolved: "isResolved", createdAt: "createdAt" },
  incidentStorms: { id: "id", projectId: "projectId", status: "status" },
  projectIntegrations: { id: "id", isActive: "isActive", projectId: "projectId" },
  projects: { id: "id", userId: "userId" },
  users: { id: "id", plan: "plan" },
  maintenanceWindows: { id: "id", projectId: "projectId", startsAt: "startsAt", endsAt: "endsAt" },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (val: string) => `decrypted_${val}`,
}));

const mockEnqueueAlert = vi.fn().mockResolvedValue(1);
vi.mock("@/lib/notifications/send", () => ({
  enqueueAlert: (...args: unknown[]) => mockEnqueueAlert(...args),
}));

const mockDispatchOutgoing = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/webhooks/outgoing", () => ({
  dispatchOutgoingWebhooks: (...args: unknown[]) => mockDispatchOutgoing(...args),
}));

const {
  verifySignature,
  createAlertIfNew,
  markIntegrationSuccess,
  generateWebhookSecret,
  signValue,
  verifySignedValue,
} = await import("@/lib/webhooks/shared");

// ── Helpers ──────────────────────────────────────────────────────────────────

function hmac(payload: string, secret: string, alg: "sha256" | "sha1" = "sha256") {
  return crypto.createHmac(alg, secret).update(payload).digest("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  selectIndex = 0;
  insertedValues.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════════════
// verifySignature
// ═══════════════════════════════════════════════════════════════════════════════

describe("verifySignature", () => {
  const secret = "test-secret-key";
  const payload = '{"action":"completed","check_run":{"conclusion":"failure"}}';

  it("returns true for a valid sha256 HMAC", () => {
    const sig = hmac(payload, secret, "sha256");
    expect(verifySignature(payload, sig, secret, "sha256")).toBe(true);
  });

  it("returns true for a valid sha1 HMAC", () => {
    const sig = hmac(payload, secret, "sha1");
    expect(verifySignature(payload, sig, secret, "sha1")).toBe(true);
  });

  it("defaults to sha256 when algorithm is not specified", () => {
    const sig = hmac(payload, secret, "sha256");
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    expect(verifySignature(payload, "deadbeef", secret)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const sig = hmac(payload, "wrong-secret");
    expect(verifySignature(payload, sig, secret)).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifySignature(payload, "", secret)).toBe(false);
  });

  it("returns false for signature with different length (timing-safe catch)", () => {
    expect(verifySignature(payload, "short", secret)).toBe(false);
  });

  it("works with Buffer payload", () => {
    const buf = Buffer.from(payload);
    const sig = hmac(payload, secret);
    expect(verifySignature(buf, sig, secret)).toBe(true);
  });

  it("rejects tampered payload", () => {
    const sig = hmac(payload, secret);
    const tampered = payload.replace("failure", "success");
    expect(verifySignature(tampered, sig, secret)).toBe(false);
  });

  it("handles unicode payloads", () => {
    const unicode = '{"msg":"🔥 fire alert"}';
    const sig = hmac(unicode, secret);
    expect(verifySignature(unicode, sig, secret)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createAlertIfNew
// ═══════════════════════════════════════════════════════════════════════════════

describe("createAlertIfNew", () => {
  const baseAlert = {
    severity: "critical" as const,
    title: "CI failing on main",
    body: "Build failed",
    sourceIntegrations: ["github"],
    isRead: false,
    isResolved: false,
  };

  // ── Standard insertion ─────────────────────────────────────────────────

  it("inserts a new alert when no duplicates exist", async () => {
    selectResults = [
      [], // no active maintenance window
      [], // no duplicate
      [], // no active storm
      [], // fewer than 4 recent alerts → no storm trigger
    ];

    const result = await createAlertIfNew(baseAlert, "proj-1");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("CI failing on main");
    expect(insertedValues.length).toBe(1);
    expect(mockEnqueueAlert).toHaveBeenCalledOnce();
    expect(mockDispatchOutgoing).toHaveBeenCalledOnce();
  });

  // ── Deduplication ──────────────────────────────────────────────────────

  it("returns null when a duplicate alert exists within 24h window", async () => {
    selectResults = [
      [], // no maintenance
      [{ id: "existing-alert" }], // dup found!
    ];

    const result = await createAlertIfNew(baseAlert, "proj-1");

    expect(result).toBeNull();
    expect(insertedValues.length).toBe(0);
    expect(mockEnqueueAlert).not.toHaveBeenCalled();
  });

  // ── Maintenance window ─────────────────────────────────────────────────

  it("suppresses alerts during active maintenance window", async () => {
    selectResults = [
      [{ id: "maint-1" }], // active maintenance!
    ];

    const result = await createAlertIfNew(baseAlert, "proj-1");

    expect(result).toBeNull();
    expect(insertedValues.length).toBe(0);
    expect(mockEnqueueAlert).not.toHaveBeenCalled();
  });

  // ── Storm detection ────────────────────────────────────────────────────

  it("triggers a storm when 4+ recent alerts exist (this is the 5th)", async () => {
    selectResults = [
      [], // no maintenance
      [], // no duplicate
      [], // no active storm
      [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "a4" }], // 4 recent alerts → storm!
    ];

    const result = await createAlertIfNew(baseAlert, "proj-1");

    expect(result).not.toBeNull();
    // Storm was triggered so notifications SHOULD fire (isTriggeringStorm = true)
    expect(mockEnqueueAlert).toHaveBeenCalledOnce();
  });

  it("attaches to existing storm without re-triggering notifications", async () => {
    selectResults = [
      [], // no maintenance
      [], // no duplicate
      [{ id: "storm-1" }], // existing active storm
    ];

    const result = await createAlertIfNew(baseAlert, "proj-1");

    expect(result).not.toBeNull();
    // Should NOT enqueue because alert is joining existing storm (not triggering)
    expect(mockEnqueueAlert).not.toHaveBeenCalled();
  });

  it("does not trigger storm with fewer than 4 recent alerts", async () => {
    selectResults = [
      [], // no maintenance
      [], // no duplicate
      [], // no active storm
      [{ id: "a1" }, { id: "a2" }], // only 2 recent → no storm
    ];

    const result = await createAlertIfNew(baseAlert, "proj-1");

    expect(result).not.toBeNull();
    expect(mockEnqueueAlert).toHaveBeenCalledOnce(); // normal notification
  });

  // ── Non-blocking failures ──────────────────────────────────────────────

  it("still returns the alert even if enqueueAlert throws", async () => {
    mockEnqueueAlert.mockRejectedValueOnce(new Error("Queue failure"));
    selectResults = [[], [], [], []];

    const result = await createAlertIfNew(baseAlert, "proj-1");

    expect(result).not.toBeNull();
    expect(insertedValues.length).toBe(1);
  });

  it("still returns the alert even if outgoing webhook dispatch throws", async () => {
    mockDispatchOutgoing.mockRejectedValueOnce(new Error("Webhook failure"));
    selectResults = [[], [], [], []];

    const result = await createAlertIfNew(baseAlert, "proj-1");

    expect(result).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// signValue / verifySignedValue
// ═══════════════════════════════════════════════════════════════════════════════

describe("signValue / verifySignedValue", () => {
  it("generates a non-empty hex signature", () => {
    const sig = signValue("channel-123");
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it("verifies a correctly signed value", () => {
    const value = "unsubscribe:channel-456";
    const token = signValue(value);
    expect(verifySignedValue(value, token)).toBe(true);
  });

  it("rejects a tampered value", () => {
    const token = signValue("original");
    expect(verifySignedValue("tampered", token)).toBe(false);
  });

  it("rejects empty token", () => {
    expect(verifySignedValue("any-value", "")).toBe(false);
  });

  it("produces deterministic signatures for same input", () => {
    const a = signValue("test");
    const b = signValue("test");
    expect(a).toBe(b);
  });

  it("produces different signatures for different inputs", () => {
    const a = signValue("input-a");
    const b = signValue("input-b");
    expect(a).not.toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// generateWebhookSecret
// ═══════════════════════════════════════════════════════════════════════════════

describe("generateWebhookSecret", () => {
  it("returns a 64-char hex string (32 bytes)", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates unique secrets on each call", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });
});
