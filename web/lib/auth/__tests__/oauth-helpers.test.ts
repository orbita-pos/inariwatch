/**
 * Tests for the two OAuth helpers used by the NextAuth jwt callback.
 *
 * `upsertProviderAccount` is the gate that links a (provider,
 * providerAccountId) pair to a userId, which is what makes
 * "logout → continue with GitHub" resolve back to the original user
 * instead of creating a new one. The unique index on those two columns
 * (migration 0086) makes the upsert idempotent across races.
 *
 * `fetchPrimaryGitHubEmail` is the Vercel-style /user/emails fetch we
 * fall back to when GitHub App user-OAuth omits email from the profile.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const insertCalls: Array<{ values: Record<string, unknown>; conflict: Record<string, unknown> }> = [];
let nextInsertThrows = false;

// Mock the db module BEFORE the helpers import it. The mock surfaces
// the same `.insert(table).values(v).onConflictDoUpdate(c)` chain
// drizzle exposes at runtime; we record both arguments so the tests
// can assert on what was actually written. `nextInsertThrows` lets a
// single test simulate a transient DB outage without rewiring the mock.
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (conflict: Record<string, unknown>) => {
          if (nextInsertThrows) {
            nextInsertThrows = false;
            throw new Error("simulated db outage");
          }
          insertCalls.push({ values, conflict });
        },
      }),
    }),
  },
  // The helpers reference `accounts` only as a column source for the
  // `target: [accounts.provider, accounts.providerAccountId]` shape on
  // onConflictDoUpdate — a Symbol satisfies the static type without
  // needing the full schema.
  accounts: {
    provider:          Symbol("accounts.provider"),
    providerAccountId: Symbol("accounts.providerAccountId"),
  },
}));

import { upsertProviderAccount, fetchPrimaryGitHubEmail } from "../oauth-helpers";

beforeEach(() => {
  insertCalls.length = 0;
});

describe("upsertProviderAccount", () => {
  const baseArgs = {
    userId:            "user-123",
    provider:          "github",
    providerAccountId: "98765",
    type:              "oauth",
    accessToken:       "gho_live",
    refreshToken:      null,
    expiresAt:         null,
  };

  it("writes one insert with the values the caller passed", async () => {
    await upsertProviderAccount(baseArgs);

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toMatchObject({
      userId:            "user-123",
      provider:          "github",
      providerAccountId: "98765",
      type:              "oauth",
      accessToken:       "gho_live",
      refreshToken:      null,
      expiresAt:         null,
    });
  });

  it("targets the (provider, providerAccountId) unique index on conflict", async () => {
    await upsertProviderAccount(baseArgs);

    const target = insertCalls[0].conflict.target as unknown[];
    expect(Array.isArray(target)).toBe(true);
    expect(target).toHaveLength(2);
    expect(String(target[0])).toBe("Symbol(accounts.provider)");
    expect(String(target[1])).toBe("Symbol(accounts.providerAccountId)");
  });

  it("on conflict, refreshes credentials and reassigns userId", async () => {
    await upsertProviderAccount(baseArgs);

    const set = insertCalls[0].conflict.set as Record<string, unknown>;
    // userId IS in the SET — that's how a stale mapping pointing at a
    // different user gets corrected on the next sign-in.
    expect(set).toMatchObject({
      userId:       "user-123",
      accessToken:  "gho_live",
      refreshToken: null,
      expiresAt:    null,
      type:         "oauth",
    });
    // providerAccountId is NOT in the SET — that's the conflict key,
    // changing it would break the upsert semantics.
    expect(set).not.toHaveProperty("providerAccountId");
  });

  it("is a no-op when providerAccountId is empty", async () => {
    // Credentials provider has no providerAccountId. This guard prevents
    // creating an unkeyed row that would later collide on conflict.
    await upsertProviderAccount({ ...baseArgs, providerAccountId: "" });
    expect(insertCalls).toHaveLength(0);
  });

  it("does not throw when the db insert fails", async () => {
    // Sign-in must not be blocked by a transient db error — the
    // mapping is best-effort. The flag is reset inside the mock so
    // subsequent tests aren't affected.
    nextInsertThrows = true;
    await expect(upsertProviderAccount(baseArgs)).resolves.toBeUndefined();
    expect(insertCalls).toHaveLength(0); // no row recorded
  });
});

describe("fetchPrimaryGitHubEmail", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: { ok: boolean; body?: unknown }) {
    globalThis.fetch = vi.fn(async () => ({
      ok:   response.ok,
      json: async () => response.body,
    })) as unknown as typeof fetch;
  }

  it("returns the primary verified email lowercased", async () => {
    mockFetch({
      ok: true,
      body: [
        { email: "Other@Example.com",   primary: false, verified: true  },
        { email: "Primary@Example.com", primary: true,  verified: true  },
      ],
    });
    expect(await fetchPrimaryGitHubEmail("token")).toBe("primary@example.com");
  });

  it("falls back to any verified email when no primary is verified", async () => {
    mockFetch({
      ok: true,
      body: [
        { email: "Primary@Example.com",   primary: true,  verified: false },
        { email: "Secondary@Example.com", primary: false, verified: true  },
      ],
    });
    expect(await fetchPrimaryGitHubEmail("token")).toBe("secondary@example.com");
  });

  it("returns null when no email is verified", async () => {
    mockFetch({
      ok: true,
      body: [
        { email: "x@y.com", primary: true,  verified: false },
        { email: "z@y.com", primary: false, verified: false },
      ],
    });
    expect(await fetchPrimaryGitHubEmail("token")).toBeNull();
  });

  it("returns null on non-ok response (App lacks email permission)", async () => {
    mockFetch({ ok: false });
    expect(await fetchPrimaryGitHubEmail("token")).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchPrimaryGitHubEmail("token")).toBeNull();
  });

  it("returns null when the response body is not an array", async () => {
    mockFetch({ ok: true, body: { message: "rate limited" } });
    expect(await fetchPrimaryGitHubEmail("token")).toBeNull();
  });
});

