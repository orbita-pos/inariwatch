/**
 * Tests for the NextAuth `signIn` callback in lib/auth.ts.
 *
 * Why this callback exists: NextAuth v4's jwt strategy doesn't pass the
 * existing session JWT into the jwt callback during an OAuth round-trip.
 * Without this gate, a logged-in user signing in with another provider
 * account that's already mapped to a DIFFERENT InariWatch user gets
 * silently swapped onto that user (Vercel/Linear/Stripe all reject
 * this case explicitly — we follow that pattern).
 *
 * Coverage:
 *   1. Credentials sign-in    → allowed (callback ignores non-OAuth).
 *   2. No existing session    → allowed (treat as fresh sign-in).
 *   3. JWT decode fails       → allowed (cookie expired/invalid → fall through).
 *   4. No accounts mapping    → allowed (first-time link is fine).
 *   5. Mapping = current user → allowed (re-linking own identity is a no-op).
 *   6. Mapping ≠ current user → REJECTED with "/login?error=OAuthAccountConflict".
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── DB mock — only the accounts lookup matters here ────────────────────

const dbState = {
  // (provider, providerAccountId) → userId mapping
  accountByProviderId: new Map<string, { userId: string }>(),
};

vi.mock("@/lib/db", () => {
  const accountsTable = {
    userId:            Symbol("accounts.userId"),
    provider:          Symbol("accounts.provider"),
    providerAccountId: Symbol("accounts.providerAccountId"),
  };
  const usersTable = { id: Symbol("users.id"), email: Symbol("users.email") };

  function flatten(c: unknown): Array<{ column: symbol; value: string }> {
    if (!c || typeof c !== "object") return [];
    if ("column" in c && "value" in c) return [c as { column: symbol; value: string }];
    if ("conditions" in c) return (c as { conditions: unknown[] }).conditions.flatMap(flatten);
    return [];
  }

  return {
    db: {
      select: () => ({
        from: () => ({
          where: (clause: unknown) => {
            const preds: { provider?: string; providerAccountId?: string } = {};
            for (const c of flatten(clause)) {
              const key = String(c.column);
              if (key.includes("provider)"))          preds.provider = c.value;
              if (key.includes("providerAccountId)")) preds.providerAccountId = c.value;
            }
            return {
              limit: async () => {
                const k = `${preds.provider}::${preds.providerAccountId}`;
                const row = dbState.accountByProviderId.get(k);
                return row ? [{ userId: row.userId }] : [];
              },
            };
          },
        }),
      }),
      // Stubs the jwt callback's own db usage — it isn't exercised here
      // but the auth module imports won't load without these.
      insert: () => ({
        values: () => ({
          returning: async () => [],
          onConflictDoUpdate: async () => undefined,
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    },
    accounts: accountsTable,
    users:    usersTable,
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...c: unknown[]) => ({ type: "and", conditions: c.flatMap(extract) }),
  or:  (...c: unknown[]) => ({ type: "or",  conditions: c.flatMap(extract) }),
  eq:  (column: symbol, value: string) => ({ column, value }),
  isNull:  () => ({ type: "isNull" }),
  inArray: () => ({ type: "inArray" }),
  sql: () => ({ type: "sql" }),
  desc: (col: unknown) => col,
  asc:  (col: unknown) => col,
}));

function extract(c: unknown): Array<{ column: symbol; value: string }> {
  if (!c || typeof c !== "object") return [];
  if ("column" in c) return [c as { column: symbol; value: string }];
  if ("conditions" in c) return (c as { conditions: unknown[] }).conditions.flatMap(extract);
  return [];
}

// ── next/headers cookies mock ──────────────────────────────────────────

let cookieJar: Map<string, string> = new Map();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => {
    const value = cookieJar.get(name);
    return value === undefined ? undefined : { value };
  } }),
}));

// ── next-auth/jwt decode mock ──────────────────────────────────────────

let decodeImpl: (args: { token: string; secret: string }) => Promise<{ id?: string } | null> =
  async () => null;
vi.mock("next-auth/jwt", () => ({
  decode: (args: { token: string; secret: string }) => decodeImpl(args),
}));

// ── Misc auth.ts deps that aren't exercised here ───────────────────────

vi.mock("@/lib/auth-rate-limit", () => ({ rateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/auth/oauth-helpers", () => ({
  upsertProviderAccount: async () => undefined,
  fetchPrimaryGitHubEmail: async () => null,
}));
vi.mock("@/lib/auth/link-github-installation", () => ({
  linkGitHubInstallationsForUser: async () => 0,
}));
vi.mock("next-auth/providers/credentials", () => ({ default: () => ({ id: "credentials", type: "credentials" }) }));
vi.mock("next-auth/providers/github",      () => ({ default: () => ({ id: "github",      type: "oauth"       }) }));
vi.mock("next-auth/providers/google",      () => ({ default: () => ({ id: "google",      type: "oauth"       }) }));
vi.mock("next-auth/providers/gitlab",      () => ({ default: () => ({ id: "gitlab",      type: "oauth"       }) }));
vi.mock("otpauth", () => ({
  TOTP:   class { validate() { return null; } },
  Secret: { fromBase32: (s: string) => s },
}));
vi.mock("bcryptjs", () => ({ default: { compare: async () => false } }));

// ── Imports & test scaffolding ─────────────────────────────────────────

import { authOptions } from "../../auth";

type SignInCallback = NonNullable<NonNullable<typeof authOptions.callbacks>["signIn"]>;
const signInCallback: SignInCallback = authOptions.callbacks!.signIn!;

beforeEach(() => {
  dbState.accountByProviderId.clear();
  cookieJar = new Map();
  decodeImpl = async () => null;
  process.env.NEXTAUTH_SECRET = "test-secret";
});

function setSession(userId: string) {
  cookieJar.set("__Secure-next-auth.session-token", "fake-token");
  decodeImpl = async () => ({ id: userId });
}

function setMapping(provider: string, providerAccountId: string, userId: string) {
  dbState.accountByProviderId.set(`${provider}::${providerAccountId}`, { userId });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("signIn callback", () => {
  it("allows credentials sign-in (non-OAuth, no providerAccountId)", async () => {
    setSession("user-A");
    const result = await signInCallback({
      account: { provider: "credentials", type: "credentials", providerAccountId: "" },
    } as Parameters<SignInCallback>[0]);
    expect(result).toBe(true);
  });

  it("allows OAuth sign-in when no session cookie exists (fresh sign-in)", async () => {
    setMapping("github", "gh-998", "user-A");
    const result = await signInCallback({
      account: { provider: "github", type: "oauth", providerAccountId: "gh-998" },
    } as Parameters<SignInCallback>[0]);
    expect(result).toBe(true);
  });

  it("allows OAuth sign-in when JWT decode fails (cookie expired/tampered)", async () => {
    cookieJar.set("__Secure-next-auth.session-token", "garbage");
    decodeImpl = async () => { throw new Error("invalid jwt"); };
    setMapping("github", "gh-998", "user-X");
    const result = await signInCallback({
      account: { provider: "github", type: "oauth", providerAccountId: "gh-998" },
    } as Parameters<SignInCallback>[0]);
    expect(result).toBe(true);
  });

  it("allows OAuth sign-in when this provider identity has no mapping yet", async () => {
    setSession("user-A");
    // No mapping for github::gh-new
    const result = await signInCallback({
      account: { provider: "github", type: "oauth", providerAccountId: "gh-new" },
    } as Parameters<SignInCallback>[0]);
    expect(result).toBe(true);
  });

  it("allows OAuth sign-in when the mapping points at the SAME user (re-link)", async () => {
    setSession("user-A");
    setMapping("github", "gh-998", "user-A");
    const result = await signInCallback({
      account: { provider: "github", type: "oauth", providerAccountId: "gh-998" },
    } as Parameters<SignInCallback>[0]);
    expect(result).toBe(true);
  });

  it("REJECTS OAuth sign-in when mapping points at a DIFFERENT user (conflict)", async () => {
    // Bersof is logged in (user-A); but github account gh-998 already
    // belongs to Jesus (user-B). Refuse the swap.
    setSession("user-A");
    setMapping("github", "gh-998", "user-B");
    const result = await signInCallback({
      account: { provider: "github", type: "oauth", providerAccountId: "gh-998" },
    } as Parameters<SignInCallback>[0]);
    expect(result).toBe("/login?error=OAuthAccountConflict");
  });

  it("uses the non-secure cookie name in dev (no __Secure- prefix)", async () => {
    cookieJar.set("next-auth.session-token", "fake-token");
    decodeImpl = async () => ({ id: "user-A" });
    setMapping("github", "gh-998", "user-B");
    const result = await signInCallback({
      account: { provider: "github", type: "oauth", providerAccountId: "gh-998" },
    } as Parameters<SignInCallback>[0]);
    expect(result).toBe("/login?error=OAuthAccountConflict");
  });
});
