import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ─────────────────────────────────────────────────────────────────

let queryResults: unknown[][] = [];
let queryIndex = 0;
const deletedWhere: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      const idx = queryIndex++;
      const result = queryResults[idx] ?? [];
      return {
        from: () => ({
          where: () => {
            const arr = [...result] as unknown[] & { limit: (n: number) => unknown[] };
            arr.limit = () => result;
            return arr;
          },
        }),
      };
    },
    insert: () => ({
      values: () => Promise.resolve(),
    }),
    delete: () => ({
      where: (w: unknown) => { deletedWhere.push(w); return Promise.resolve(); },
    }),
  },
  notificationChannels: { id: "id", userId: "userId", type: "type" },
  notificationLogs: { channelId: "channelId", status: "status", sentAt: "sentAt" },
  emailSuppressions: { id: "id", email: "email", reason: "reason" },
}));

const {
  checkEmailRateLimit,
  isEmailSuppressed,
  suppressEmail,
  unsuppressEmail,
  checkVerificationCooldown,
  trackVerificationSent,
} = await import("../rate-limit");

beforeEach(() => {
  vi.clearAllMocks();
  queryResults = [];
  queryIndex = 0;
  deletedWhere.length = 0;
});

// ── checkEmailRateLimit ─────────────────────────────────────────────────────

describe("checkEmailRateLimit", () => {
  it("allows when global limit not reached and no user channels", async () => {
    queryResults = [
      [{ count: 10 }],  // global count: 10 (under 500)
      [],                // no email channels
    ];

    const result = await checkEmailRateLimit("user-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks when global daily limit reached", async () => {
    queryResults = [
      [{ count: 500 }], // global limit hit
    ];

    const result = await checkEmailRateLimit("user-1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Global");
  });

  it("allows when under hourly and daily per-user limits", async () => {
    queryResults = [
      [{ count: 50 }],   // global OK
      [{ id: "ch-1" }],  // user has email channel
      [{ count: 3 }],    // hourly: 3
      [{ count: 10 }],   // daily: 10
    ];

    const result = await checkEmailRateLimit("user-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks when hourly per-user limit reached", async () => {
    queryResults = [
      [{ count: 50 }],   // global OK
      [{ id: "ch-1" }],  // user has email channel
      [{ count: 10 }],   // hourly limit hit
    ];

    const result = await checkEmailRateLimit("user-1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Hourly");
  });

  it("blocks when daily per-user limit reached", async () => {
    queryResults = [
      [{ count: 50 }],   // global OK
      [{ id: "ch-1" }],  // user has email channel
      [{ count: 5 }],    // hourly OK
      [{ count: 50 }],   // daily limit hit
    ];

    const result = await checkEmailRateLimit("user-1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Daily");
  });
});

// ── isEmailSuppressed ───────────────────────────────────────────────────────

describe("isEmailSuppressed", () => {
  it("returns false when email not in suppression list", async () => {
    queryResults = [[]]; // no entry

    const result = await isEmailSuppressed("ok@test.com");
    expect(result).toBe(false);
  });

  it("returns true when email is suppressed", async () => {
    queryResults = [[{ id: "sup-1" }]]; // found

    const result = await isEmailSuppressed("bounced@test.com");
    expect(result).toBe(true);
  });
});

// ── suppressEmail ───────────────────────────────────────────────────────────

describe("suppressEmail", () => {
  it("does not throw when inserting new suppression", async () => {
    queryResults = [[]]; // not existing

    await expect(suppressEmail("bad@test.com", "bounce")).resolves.not.toThrow();
  });

  it("does not insert duplicate when already suppressed", async () => {
    queryResults = [[{ id: "existing" }]]; // already exists

    await expect(suppressEmail("bad@test.com", "bounce")).resolves.not.toThrow();
  });
});

// ── checkVerificationCooldown ───────────────────────────────────────────────

describe("checkVerificationCooldown", () => {
  it("allows first request", () => {
    const result = checkVerificationCooldown("fresh-user");
    expect(result.allowed).toBe(true);
  });

  it("blocks within cooldown period", () => {
    trackVerificationSent("cd-user");
    const result = checkVerificationCooldown("cd-user");
    expect(result.allowed).toBe(false);
    expect(result.retryInSeconds).toBeGreaterThan(0);
  });

  it("different users have independent cooldowns", () => {
    trackVerificationSent("user-x");
    expect(checkVerificationCooldown("user-x").allowed).toBe(false);
    expect(checkVerificationCooldown("user-y").allowed).toBe(true);
  });
});
